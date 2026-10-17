import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { inheritedEnvironment, projectRoot } from "./config.js";
import { listRuns, selectRun, snapshotEvidence } from "./evidence.js";

test("real stdio proxy forwards schemas, calls and errors and exposes notes/export", async () => {
  const root = await mkdtemp(join(tmpdir(), "kusto-proxy-test-"));
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", join(import.meta.dir, "fixtures", "proxy.ts")],
    env: { ...inheritedEnvironment(), RECORDER_TEST_ROOT: root },
    stderr: "inherit",
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(["kusto", "record_investigation_note", "get_investigation_notebook"]);
    expect(tools.tools[0].inputSchema).toEqual({ type: "object", properties: {} });
    expect(tools.tools[0].description).toBe("Fixture Kusto router");
    expect(client.getInstructions()).toContain("Fixture upstream instructions must survive wrapping.");
    const args = { command: "kusto_query", parameters: { database: "sample", query: "print 1" } };
    const result = CallToolResultSchema.parse(await client.callTool({ name: "kusto", arguments: args }));
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ received: args }) }],
      isError: false,
    });
    const runs = await listRuns(root);
    expect(selectRun(runs).id).toBe("integration");
    const snapshot = await snapshotEvidence(root, "integration");
    const automatic = JSON.parse(await readFile(snapshot.notebook, "utf8"));
    const id = automatic.metadata.kusto_recorder.entries[0].id;
    expect(automatic.cells.some((cell: { id: string }) => cell.id === id)).toBe(true);
    expect(automatic.cells.filter((cell: { id: string }) => cell.id.startsWith("N-"))).toHaveLength(0);
    await client.callTool({ name: "record_investigation_note", arguments: { kind: "conclusion", text: "A test conclusion.", evidence_ids: [id] } });
    const failure = await client.callTool({ name: "kusto", arguments: { command: "fail" } });
    expect(failure.isError).toBe(true);
    const exported = CallToolResultSchema.parse(await client.callTool({ name: "get_investigation_notebook" }));
    const block = exported.content[0];
    if (block.type !== "text") throw new Error("Expected export information.");
    const info = JSON.parse(block.text);
    expect(info.executions).toHaveLength(2);
    expect(info.notes).toBe(1);
    const notebook = JSON.parse(await readFile(info.notebook, "utf8"));
    expect(notebook.metadata.kusto_recorder.entries.find((entry: { type: string }) => entry.type === "note").text).toBe("A test conclusion.");
    const invalidNote = await client.callTool({ name: "record_investigation_note", arguments: { kind: "conclusion", text: "Bad citation", evidence_ids: ["not-real"] } });
    expect(invalidNote.isError).toBe(true);
  } finally {
    await client.close();
    await transport.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("command-prefix launch preserves a team's stdio server and replays its original requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "kusto-team-server-"));
  const recordingRoot = join(root, "recordings");
  const upstreamArgs = ["run", join(import.meta.dir, "fixtures", "upstream.ts"), "two words", "--team-option", "a=b"];
  const env = {
    ...inheritedEnvironment(), RECORDER_TEST_CUSTOM: "1", RECORDER_TEST_SETTING: "team environment",
    KUSTO_RECORDING_DIR: recordingRoot, KUSTO_INVESTIGATION_ID: "team-run",
  };
  const directClient = new Client({ name: "direct-test", version: "1.0.0" });
  const direct = new StdioClientTransport({
    command: process.execPath, args: upstreamArgs, cwd: root, env, stderr: "inherit",
  });
  const client = new Client({ name: "wrapped-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", join(import.meta.dir, "bootstrap.ts"), "--", process.execPath, ...upstreamArgs],
    cwd: root, env, stderr: "inherit",
  });
  const request = { name: "run_team_query", arguments: { kql: "print 7", target: "team database" }, _meta: { team: "metadata" } };
  try {
    await directClient.connect(direct);
    const expectedTools = await directClient.listTools();
    const expected = await directClient.callTool(request);
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools[0]).toEqual(expectedTools.tools[0]);
    expect(client.getInstructions()).toContain("Fixture upstream instructions must survive wrapping.");
    expect(await client.callTool(request)).toEqual(expected);
    const notebookPath = join(recordingRoot, "team-run", "investigation.ipynb");
    const notebook = JSON.parse(await readFile(notebookPath, "utf8"));
    const upstream = { command: process.execPath, args: upstreamArgs, cwd: root };
    expect(notebook.metadata.kusto_recorder.upstream).toEqual(upstream);
    expect(notebook.metadata.kusto_recorder.upstream_version).toBeUndefined();
    expect(notebook.metadata.kusto_recorder.entries[0].request).toEqual(request);
    expect(notebook.cells[2].source).toStartWith("%%mcp\n");
    expect(JSON.parse(notebook.cells[2].source.slice("%%mcp\n".length))).toEqual(request);
    expect(notebook.cells[2].outputs[0].data["text/plain"]).toContain("team database");
    expect(notebook.metadata.kusto_recorder.upstream.env).toBeUndefined();
    const snapshot = await snapshotEvidence(recordingRoot, "team-run");
    const exported = JSON.parse(await readFile(snapshot.notebook, "utf8"));
    expect(exported.metadata.kusto_recorder.upstream).toEqual(upstream);
    expect(exported.cells[1].source).not.toContain("run_team_query");
    const replay = Bun.spawn([process.execPath, "run", join(import.meta.dir, "replay.ts")], {
      cwd: projectRoot,
      env: { ...env, KUSTO_INVESTIGATION_ID: "team-replay", KUSTO_REPLAY_UPSTREAM: JSON.stringify(upstream) },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    replay.stdin.write(JSON.stringify(request));
    replay.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(replay.stdout).text(), new Response(replay.stderr).text(), replay.exited,
    ]);
    if (exitCode !== 0) throw new Error(`Custom replay failed: ${stderr}`);
    expect(JSON.parse(stdout)).toEqual(expected);
    const replayNotebook = JSON.parse(await readFile(join(recordingRoot, "team-replay", "investigation.ipynb"), "utf8"));
    expect(replayNotebook.metadata.kusto_recorder.upstream).toEqual(upstream);
    expect(replayNotebook.metadata.kusto_recorder.entries[0].request).toEqual(request);
  } finally {
    await client.close();
    await transport.close();
    await directClient.close();
    await direct.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
