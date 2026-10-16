import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { inheritedEnvironment } from "./config.js";
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
    const args = { command: "kusto_query", parameters: { database: "sample", query: "print 1" } };
    const result = CallToolResultSchema.parse(await client.callTool({ name: "kusto", arguments: args }));
    expect(result.content[0]).toEqual({ type: "text", text: JSON.stringify({ received: args }) });
    const footer = result.content[1];
    if (footer.type !== "text") throw new Error("Missing evidence footer.");
    const id = /E-[\da-f-]+/.exec(footer.text)?.[0];
    expect(id).toBeDefined();
    expect(footer.text).not.toContain("record_investigation_note");
    const runs = await listRuns(root);
    expect(selectRun(runs).id).toBe("integration");
    const snapshot = await snapshotEvidence(root, "integration");
    const automatic = JSON.parse(await readFile(snapshot.notebook, "utf8"));
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
    expect(notebook.metadata.kusto_recorder.notes[0].text).toBe("A test conclusion.");
    const invalidNote = await client.callTool({ name: "record_investigation_note", arguments: { kind: "conclusion", text: "Bad citation", evidence_ids: ["not-real"] } });
    expect(invalidNote.isError).toBe(true);
  } finally {
    await client.close();
    await transport.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
