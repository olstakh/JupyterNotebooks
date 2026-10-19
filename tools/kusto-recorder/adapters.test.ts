import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Recorder } from "./recorder.js";
import { createRecorder } from "./application.js";
import { mcpAdapter } from "./adapters/mcp.js";
import { isObject, jsonObject, jsonValue, type ExecutionAdapter, type NotebookAdapter } from "./model.js";
import { snapshotEvidence } from "./evidence.js";

const roots: string[] = [];
async function root() {
  const directory = await mkdtemp(join(tmpdir(), "kusto-adapter-test-"));
  roots.push(directory);
  return directory;
}
afterEach(async () => {
  for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true });
});

type FixtureRequest = { query: string; database: string };
type FixtureResult = { rows: number[]; failed: boolean };
const fixture: ExecutionAdapter<FixtureRequest, FixtureResult> = {
  id: "fixture",
  captureRequest: jsonObject,
  captureResult: jsonObject,
  isError: (result) => result.failed,
};

test("records non-MCP data with the same pending/completion guarantees and returns the original result", async () => {
  const directory = await root();
  const recorder = new Recorder(directory, "neutral");
  await recorder.initialize();
  const request = { query: "print 7", database: "fixture" };
  const response = { rows: [7], failed: false };
  const { entry, result } = await recorder.execute(fixture, request, async () => {
    expect((await recorder.entries())[0]).toMatchObject({ adapter: "fixture", status: "started", request });
    return response;
  });
  expect(result).toBe(response);
  expect(entry).toMatchObject({ adapter: "fixture", request, result: response, status: "succeeded" });
  expect((await new Recorder(directory, "neutral").entries())[0]).toEqual(entry);
  const snapshot = await snapshotEvidence(directory, "neutral");
  const notebook = JSON.parse(await readFile(snapshot.notebook, "utf8"));
  expect(notebook.metadata.kusto_recorder.entries[0]).toEqual(entry);
  expect(notebook.metadata.kusto_recorder).not.toHaveProperty("upstream_version");
  expect(notebook.cells.some((cell: { source: string }) => cell.source.startsWith("%%mcp"))).toBe(false);
  expect(notebook.cells.some((cell: { source: string }) => cell.source.includes('No replay adapter is installed for \\"fixture\\"'))).toBe(true);
});

test("adapter-defined failures do not need MCP error envelopes", async () => {
  const recorder = new Recorder(await root(), "failed");
  await recorder.initialize();
  const { entry } = await recorder.execute(fixture, { query: "invalid", database: "fixture" }, async () => ({ rows: [], failed: true }));
  expect(entry.status).toBe("failed");
  const notebook = await recorder.snapshotNotebook();
  expect(notebook.cells.find((cell) => cell.id === entry.id)?.outputs?.[0]).toMatchObject({
    output_type: "error", ename: "RecordedExecutionError",
  });
});

test("a non-MCP notebook adapter supplies its own query, setup, and result presentation", async () => {
  const view: NotebookAdapter = {
    id: "fixture",
    validateEntry(entry) {
      if (!isObject(entry.request) || typeof entry.request.query !== "string") throw new Error("Invalid fixture request.");
    },
    validateConfiguration(value) {
      jsonObject(value);
    },
    describe(entry) {
      if (!isObject(entry.request) || typeof entry.request.query !== "string") throw new Error("Invalid fixture request.");
      return {
        query: { text: entry.request.query, magic: "fixture", connection: { database: "fixture" } },
        intent: "Check the fixture",
        outputs: [{ output_type: "display_data", data: { "text/plain": "Fixture result" }, metadata: {} }],
      };
    },
    setup(connections) {
      return `# Fixture setup: ${JSON.stringify(connections)}`;
    },
    metadata: () => ({}),
  };
  const recorder = new Recorder(await root(), "presentation", { adapters: [view], configurations: { fixture: {} } });
  await recorder.initialize();
  await recorder.execute(fixture, { query: "print 7", database: "fixture" }, async () => ({ rows: [7], failed: false }));
  const notebook = await recorder.snapshotNotebook();
  expect(notebook.cells[1].source).toContain("Fixture setup");
  expect(notebook.cells[2].source).toBe("%%fixture\n// Intent: Check the fixture\nprint 7");
  expect(notebook.cells[2].outputs).toEqual([{ output_type: "display_data", data: { "text/plain": "Fixture result" }, metadata: {} }]);
  expect(notebook.metadata.kusto_recorder).not.toHaveProperty("upstream_version");
});

test("invalid request evidence prevents execution and invalid completion evidence withholds results", async () => {
  const recorder = new Recorder(await root(), "invalid");
  await recorder.initialize();
  let executed = false;
  const invalidRequest = { ...fixture, captureRequest: () => jsonValue(undefined) };
  await expect(recorder.execute(invalidRequest, { query: "print 1", database: "fixture" }, async () => {
    executed = true;
    return { rows: [1], failed: false };
  })).rejects.toThrow("JSON");
  expect(executed).toBe(false);
  const invalidResult = { ...fixture, captureResult: () => jsonValue(Number.NaN) };
  await expect(recorder.execute(invalidResult, { query: "print 1", database: "fixture" }, async () => ({ rows: [1], failed: false }))).rejects.toThrow("results withheld");
  expect((await recorder.entries())[0]).toMatchObject({ status: "started", adapter: "fixture" });
});

test("retains valid primitive and null response evidence", async () => {
  const recorder = new Recorder(await root(), "primitives");
  await recorder.initialize();
  const adapter: ExecutionAdapter<string, null> = {
    id: "fixture", captureRequest: jsonValue, captureResult: jsonValue, isError: () => false,
  };
  const { entry } = await recorder.execute(adapter, "print 1", async () => null);
  expect(entry.result).toBeNull();
  expect((await recorder.entries())[0]).toMatchObject({ request: "print 1", result: null, status: "succeeded" });
});

test("rejects evidence that would be silently changed by JSON serialization", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, undefined, new Date(), { ignored: undefined }, new Array(1)]) {
    expect(() => jsonValue(value)).toThrow("JSON");
  }
});

test("migrates v2 MCP evidence and custom replay configuration without changing the original source during export", async () => {
  const directory = await root();
  const recorder = createRecorder(directory, "legacy");
  await recorder.initialize();
  const upstream = { command: "team-mcp", args: ["--team", "original"], cwd: directory };
  const entry = {
    type: "execution", id: "E-abcd", startedAt: "2026-01-01T00:00:00Z", status: "tool_error",
    request: { name: "team_query", arguments: { query: "print 1" } },
    result: { content: [{ type: "text", text: "Access denied" }], isError: true },
  };
  const original = JSON.stringify({
    nbformat: 4, metadata: { kusto_recorder: { format_version: 2, run_id: "legacy", upstream: {
      cwd: upstream.cwd, args: upstream.args, command: upstream.command,
    }, entries: [entry] } },
    cells: [],
  });
  await writeFile(recorder.notebookPath, original);
  const snapshot = await snapshotEvidence(directory, "legacy");
  expect(await readFile(recorder.notebookPath, "utf8")).toBe(original);
  const notebook = JSON.parse(await readFile(snapshot.notebook, "utf8"));
  expect(notebook.metadata.kusto_recorder.format_version).toBe(3);
  expect(notebook.metadata.kusto_recorder.adapter_configurations).toEqual({ mcp: upstream });
  expect(notebook.metadata.kusto_recorder.upstream).toEqual(upstream);
  expect(notebook.metadata.kusto_recorder.entries[0]).toMatchObject({
    adapter: "mcp", status: "failed", request: entry.request, result: entry.result,
  });
  expect(notebook.cells[2].source).toStartWith("%%mcp\n");
  await createRecorder(directory, "legacy", { upstream, verifyUpstream: true }).initialize();
  expect(JSON.parse(await readFile(recorder.notebookPath, "utf8")).metadata.kusto_recorder.format_version).toBe(3);
});

test("validates known adapter payloads and rejects missing adapter IDs in v3 instead of assuming MCP", async () => {
  const directory = await root();
  const recorder = createRecorder(directory, "corrupt");
  await recorder.initialize();
  await recorder.execute(mcpAdapter, { name: "kusto", arguments: { learn: true } }, async () => ({ content: [] }));
  const notebook = JSON.parse(await readFile(recorder.notebookPath, "utf8"));
  delete notebook.metadata.kusto_recorder.entries[0].request.name;
  await writeFile(recorder.notebookPath, JSON.stringify(notebook));
  await expect(createRecorder(directory, "corrupt").entries()).rejects.toThrow();
  notebook.metadata.kusto_recorder.entries[0].request.name = "kusto";
  delete notebook.metadata.kusto_recorder.entries[0].adapter;
  await writeFile(recorder.notebookPath, JSON.stringify(notebook));
  await expect(createRecorder(directory, "corrupt").entries()).rejects.toThrow("adapter ID");
  notebook.metadata.kusto_recorder.entries[0].adapter = "mcp";
  delete notebook.metadata.kusto_recorder.adapter_configurations.mcp;
  await writeFile(recorder.notebookPath, JSON.stringify(notebook));
  await expect(createRecorder(directory, "corrupt").entries()).rejects.toThrow("configuration is missing");
});
