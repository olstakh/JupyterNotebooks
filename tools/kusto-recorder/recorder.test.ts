import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Recorder } from "./recorder.js";
import { makeNotebook } from "./notebook.js";

const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kusto-recorder-test-"));
  roots.push(root);
  const recorder = new Recorder(root, "test-run");
  await recorder.initialize();
  return recorder;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const request = {
  name: "kusto",
  arguments: { command: "kusto_query", parameters: { "cluster-uri": "https://example.kusto.windows.net", database: "logs", query: 'print text = "hello"' } },
};
const success = { content: [{ type: "text" as const, text: '{"status":200,"results":{"items":[{"Count":"long"},[10]]}}' }] };

describe("durable recording", () => {
  test("persists intent before execution, original response, notes and a notebook", async () => {
    const recorder = await setup();
    const { entry, result } = await recorder.execute(request, async () => {
      const entries = await recorder.entries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ status: "started", request });
      return success;
    });
    expect(result).toEqual(success);
    await recorder.note({ kind: "observation", text: "The sample contains ten rows.", evidence_ids: [entry.id] });
    const entries = await recorder.entries();
    expect(entries).toHaveLength(2);
    expect(entries.find((item) => item.type === "execution")).toMatchObject({ status: "succeeded", result: success });
    const notebook = JSON.parse(await readFile(recorder.notebookPath, "utf8"));
    expect(notebook.nbformat).toBe(4);
    expect(notebook.cells.some((cell: { source: string }) => cell.source.includes("ten rows"))).toBe(true);
    expect(notebook.cells.find((cell: { id: string }) => cell.id === entry.id).outputs[0].data["application/json"]).toEqual(success);
    const first = await readFile(recorder.notebookPath, "utf8");
    await recorder.exportNotebook();
    expect(await readFile(recorder.notebookPath, "utf8")).toBe(first);
  });

  test("records tool errors without converting them to success", async () => {
    const recorder = await setup();
    const failure = { content: [{ type: "text" as const, text: "Permission denied" }], isError: true };
    const { entry, result } = await recorder.execute(request, async () => failure);
    expect(entry.status).toBe("tool_error");
    expect(result.isError).toBe(true);
  });

  test("records uncertain outcomes for transport failures", async () => {
    const recorder = await setup();
    await expect(recorder.execute(request, async () => { throw new Error("Timed out"); })).rejects.toThrow("may have reached Kusto");
    expect((await recorder.entries())[0]).toMatchObject({ status: "transport_error", error: "Timed out" });
  });

  test("does not execute when intent persistence fails", async () => {
    const recorder = await setup();
    await rm(recorder.directory, { recursive: true });
    let executed = false;
    await expect(recorder.execute(request, async () => { executed = true; return success; })).rejects.toThrow();
    expect(executed).toBe(false);
  });

  test("withholds results when completion persistence fails", async () => {
    const recorder = await setup();
    await expect(recorder.execute(request, async () => {
      await rename(recorder.directory, `${recorder.directory}-moved`);
      return success;
    })).rejects.toThrow("results withheld");
  });

  test("concurrent calls remain distinct and notebook has every execution once", async () => {
    const recorder = await setup();
    const results = await Promise.all(Array.from({ length: 8 }, () => recorder.execute(request, async () => success)));
    const notebook = JSON.parse(await readFile(recorder.notebookPath, "utf8"));
    expect(await recorder.entries()).toHaveLength(8);
    for (const { entry } of results) {
      expect(notebook.cells.filter((cell: { id: string }) => cell.id === entry.id)).toHaveLength(1);
    }
  });

  test("rejects invented evidence and path traversal in run IDs", async () => {
    const recorder = await setup();
    await expect(recorder.note({ kind: "conclusion", text: "Not supported.", evidence_ids: ["invented"] })).rejects.toThrow("unknown evidence");
    expect(() => new Recorder(recorder.directory, "..\\escape")).toThrow("Investigation ID");
  });

  test("rebuilds a missing notebook and labels unfinished executions", async () => {
    const recorder = await setup();
    await writeFile(join(recorder.directory, "E-abcd.json"), JSON.stringify({
      type: "execution", id: "E-abcd", status: "started", startedAt: "2026-01-01T00:00:00Z", request,
    }));
    await rm(recorder.notebookPath);
    await recorder.exportNotebook();
    expect(await readFile(recorder.notebookPath, "utf8")).toContain("no outcome recorded");
  });

  test("generates executable replay cells with exact parameters and separate run ID", () => {
    const notebook = makeNotebook("example", [{
      type: "execution", id: "E-abcd", startedAt: "2026-01-01T00:00:00Z", status: "succeeded", request, result: success,
    }]);
    expect(notebook.cells.find((cell) => cell.id === "E-abcd")?.source).toContain("run_kusto(**json.loads(");
    expect(notebook.cells.find((cell) => cell.id === "replay-setup")?.source).toContain('replay_run_id = "replay-"');
  });

  test("renders a readable result table and escapes telemetry HTML", () => {
    const notebook = makeNotebook("example", [{
      type: "execution", id: "E-abcd", startedAt: "2026-01-01T00:00:00Z", status: "succeeded", request,
      result: { content: [{ type: "text", text: JSON.stringify({
        status: 200, results: { items: [{ Message: "string" }, ["<script>alert('x')</script>"]] },
      }) }] },
    }]);
    const rendered = JSON.stringify(notebook.cells.find((cell) => cell.id === "E-abcd")?.outputs);
    expect(rendered).toContain("<table>");
    expect(rendered).toContain("&lt;script&gt;");
    expect(rendered).toContain("Original MCP response");
  });
});
