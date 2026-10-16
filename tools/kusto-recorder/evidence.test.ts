import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Recorder } from "./recorder.js";
import { listRuns, selectRun, snapshotEvidence, type Run } from "./evidence.js";
import { registerSession } from "./sessions.js";

const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kusto-evidence-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function run(id: string, active = false): Run {
  return { id, active, lastActivity: "2026-01-01T00:00:00Z", executions: 1 };
}

test("selects the sole active run instead of an unrelated saved run", () => {
  expect(selectRun([run("newest-saved"), run("current", true)]).id).toBe("current");
  expect(selectRun([run("newest-saved"), run("older-saved")]).id).toBe("newest-saved");
  expect(selectRun([{ ...run("unused-startup"), executions: 0 }, run("last-evidence")]).id).toBe("last-evidence");
});

test("does not guess between simultaneous recorder sessions", () => {
  const runs = [run("first", true), run("second", true)];
  expect(() => selectRun(runs)).toThrow("Multiple recorder sessions");
  expect(selectRun(runs, "second").id).toBe("second");
  expect(() => selectRun(runs, "missing")).toThrow("No recorded run");
  expect(() => selectRun([])).toThrow("No recorded investigations");
});

test("exports evidence without annotations or an agent, preserving existing notebooks", async () => {
  const root = await setup();
  const recorder = new Recorder(root, "current");
  await recorder.initialize();
  const finish = await registerSession(recorder.directory);
  const { entry } = await recorder.execute({
    name: "kusto", arguments: { intent: "Check recent failures", command: "kusto_query", parameters: { query: "print 1", database: "test" } },
  }, async () => ({ content: [{ type: "text", text: "Recorded response" }] }));
  const original = await readFile(recorder.notebookPath, "utf8");
  const runs = await listRuns(root);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ id: "current", active: true, executions: 1 });
  const first = await snapshotEvidence(root, selectRun(runs).id);
  const second = await snapshotEvidence(root, "current");
  expect(first.notebook).not.toBe(second.notebook);
  expect(await readFile(recorder.notebookPath, "utf8")).toBe(original);
  const notebook = JSON.parse(await readFile(first.notebook, "utf8"));
  expect(notebook.cells.find((cell: { id: string }) => cell.id === entry.id).metadata.kusto_recorder.request.arguments.intent).toBe("Check recent failures");
  expect(notebook.cells.some((cell: { id: string }) => cell.id === entry.id)).toBe(true);
  expect((await recorder.entries()).every((item) => item.type === "execution")).toBe(true);
  expect((await listRuns(root))[0].lastActivity).toBe(runs[0].lastActivity);
  await finish();
  expect((await listRuns(root))[0].active).toBe(false);
});

test("supports legacy recordings and rejects corrupt session metadata", async () => {
  const root = await setup();
  expect(await listRuns(join(root, "not-created"))).toEqual([]);
  const recorder = new Recorder(root, "legacy");
  await recorder.initialize();
  expect((await listRuns(root))[0]).toMatchObject({ id: "legacy", active: false });
  await writeFile(join(recorder.directory, "session.json"), '{"pid":"wrong"}');
  await expect(listRuns(root)).rejects.toThrow("Invalid session metadata");
});

test("command exports a saved run offline and prints its notebook path", async () => {
  const root = await setup();
  const recorder = new Recorder(root, "offline");
  await recorder.initialize();
  const completed = Bun.spawnSync([process.execPath, "run", join(import.meta.dir, "evidence.ts")], {
    env: { ...process.env, KUSTO_RECORDING_DIR: root, KUSTO_INVESTIGATION_ID: "" },
    stdout: "pipe", stderr: "pipe",
  });
  expect(completed.exitCode).toBe(0);
  const path = new TextDecoder().decode(completed.stdout).trim();
  expect(path).toContain("snapshot-");
  expect(JSON.parse(await readFile(path, "utf8")).metadata.kusto_recorder.run_id).toBe("offline");
});
