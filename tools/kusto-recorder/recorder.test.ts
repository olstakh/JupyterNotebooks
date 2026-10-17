import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Recorder, type Execution } from "./recorder.js";
import { isQueryError, makeNotebook, renderResult } from "./notebook.js";

const roots: string[] = [];
async function setup(options: { debugJson?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "kusto-recorder-test-"));
  roots.push(root);
  const recorder = new Recorder(root, "test-run", options);
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
      const notebook = JSON.parse(await readFile(recorder.notebookPath, "utf8"));
      expect(notebook.metadata.kusto_recorder.entries[0]).toMatchObject({ status: "started", request });
      expect(notebook.cells[2].execution_count).toBeNull();
      return success;
    });
    expect(result).toEqual(success);
    await recorder.note({ kind: "observation", text: "The sample contains ten rows.", evidence_ids: [entry.id] });
    const entries = await recorder.entries();
    expect(entries).toHaveLength(2);
    expect(entries.find((item) => item.type === "execution")).toMatchObject({ status: "succeeded", result: success });
    const notebook = JSON.parse(await readFile(recorder.notebookPath, "utf8"));
    expect(notebook.nbformat).toBe(4);
    expect(notebook.metadata.kusto_recorder.entries.find((item: { type: string }) => item.type === "note").text).toContain("ten rows");
    expect(notebook.metadata.kusto_recorder.entries.find((item: { id: string }) => item.id === entry.id).result).toEqual(success);
    expect(notebook.cells).toHaveLength(3);
    expect(await readdir(recorder.directory)).toEqual(["investigation.ipynb"]);
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
    const previous = JSON.parse(await readFile(join(`${recorder.directory}-moved`, "investigation.ipynb"), "utf8"));
    expect(previous.metadata.kusto_recorder.entries[0]).toMatchObject({ status: "started", request });
    expect(previous.metadata.kusto_recorder.entries[0].result).toBeUndefined();
  });

  test("reports uncertainty when upstream and final persistence both fail", async () => {
    const recorder = await setup();
    await expect(recorder.execute(request, async () => {
      await rename(recorder.directory, `${recorder.directory}-moved`);
      throw new Error("Connection lost");
    })).rejects.toThrow("the query may have reached Kusto");
    const previous = JSON.parse(await readFile(join(`${recorder.directory}-moved`, "investigation.ipynb"), "utf8"));
    expect(previous.metadata.kusto_recorder.entries[0].status).toBe("started");
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

  test("imports legacy JSON records and labels unfinished executions", async () => {
    const recorder = await setup();
    await writeFile(join(recorder.directory, "E-abcd.json"), JSON.stringify({
      type: "execution", id: "E-abcd", status: "started", startedAt: "2026-01-01T00:00:00Z", request,
    }));
    await rm(recorder.notebookPath);
    const reader = new Recorder(join(recorder.directory, ".."), recorder.runId);
    await reader.exportNotebook();
    expect(await readFile(recorder.notebookPath, "utf8")).toContain("no outcome recorded");
    expect((await reader.entries())[0]).toMatchObject({ status: "started", request });
  });

  test("generates executable replay cells with exact parameters and separate run ID", () => {
    const notebook = makeNotebook("example", [{
      type: "execution", id: "E-abcd", startedAt: "2026-01-01T00:00:00Z", status: "succeeded", request, result: success,
    }]);
    expect(notebook.cells.find((cell) => cell.id === "E-abcd")?.source).toBe('%%kusto\nprint text = "hello"');
    expect(notebook.cells.find((cell) => cell.id === "replay-setup")?.metadata).toMatchObject({ jupyter: { source_hidden: true } });
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
    expect(rendered).not.toContain("Original MCP response");
    expect(rendered).not.toContain("application/json");
  });

  test("keeps discovery out of the visible notebook and retains all original query evidence", () => {
    const notebook = makeNotebook("example", [
      { type: "execution", id: "E-abcd", startedAt: "2026-01-01T00:00:00Z", status: "succeeded", request, result: success },
      { type: "execution", id: "E-efab", startedAt: "2026-01-01T00:00:01Z", status: "succeeded", request: { name: "kusto", arguments: { learn: true } }, result: success },
    ]);
    expect(notebook.cells).toHaveLength(3);
    expect(notebook.metadata.kusto_recorder.omitted_discovery_calls).toBe(1);
    expect(notebook.metadata.kusto_recorder.entries).toHaveLength(2);
    expect(notebook.metadata.kusto_recorder.entries[0]).toMatchObject({ request, result: success });
    expect(notebook.cells[2].metadata.kusto_recorder).toBeUndefined();
  });

  test("uses distinct connections for different targets and converts sample calls to runnable KQL", () => {
    const notebook = makeNotebook("example", [
      { type: "execution", id: "E-abcd", startedAt: "2026-01-01T00:00:00Z", status: "succeeded", request, result: success },
      {
        type: "execution", id: "E-efab", startedAt: "2026-01-01T00:00:01Z", status: "succeeded", result: success,
        request: { name: "kusto_sample", arguments: { "cluster-uri": "https://other.kusto.windows.net", database: "other", table: "event", limit: 5 } },
      },
    ]);
    expect(notebook.cells[2].source).toStartWith("%%kusto\n");
    expect(notebook.cells[3].source).toBe('%%kusto connection2\ntable("event")\n| take 5');
    expect(notebook.cells[1].source).toContain("other.kusto.windows.net");
  });

  test("renders payload errors as errors even when the MCP transport succeeds", () => {
    const result = { content: [{ type: "text" as const, text: '{"status":403,"message":"Access denied"}' }] };
    expect(isQueryError(result)).toBe(true);
    expect(renderResult(result)).toMatchObject({ output_type: "error", ename: "KustoQueryError" });
  });

  test("shows structured-only results from another MCP server", () => {
    const output = renderResult({ content: [], structuredContent: { rows: [{ Count: 7 }] } });
    expect(output).toMatchObject({
      output_type: "display_data",
      data: { "text/plain": JSON.stringify({ rows: [{ Count: 7 }] }, null, 2) },
    });
  });

  test("reads all evidence from the notebook after reopening without per-call files", async () => {
    const recorder = await setup();
    await recorder.execute(request, async () => success);
    await recorder.execute({ name: "kusto", arguments: { learn: true } }, async () => success);
    const reopened = new Recorder(join(recorder.directory, ".."), recorder.runId);
    expect(await reopened.entries()).toHaveLength(2);
    expect(await readdir(recorder.directory)).toEqual(["investigation.ipynb"]);
    await reopened.initialize();
    expect(await reopened.entries()).toHaveLength(2);
  });

  test("preserves custom upstream settings offline and rejects recording with another server", async () => {
    const root = await mkdtemp(join(tmpdir(), "kusto-upstream-recording-"));
    roots.push(root);
    const upstream = { command: "team-mcp", args: ["--team", "original"], cwd: root };
    const recorder = new Recorder(root, "custom-run", { upstream, verifyUpstream: true });
    await recorder.initialize();
    await recorder.execute({ name: "team_query", arguments: { kql: "print 1" } }, async () => success);
    const reader = new Recorder(root, "custom-run");
    await reader.exportNotebook();
    const notebook = JSON.parse(await readFile(reader.notebookPath, "utf8"));
    expect(notebook.metadata.kusto_recorder.upstream).toEqual(upstream);
    expect(notebook.cells[2].source).toStartWith("%%mcp\n");
    await expect(new Recorder(root, "custom-run", { verifyUpstream: true }).initialize()).rejects.toThrow("different upstream");
    await expect(new Recorder(root, "custom-run", {
      upstream: { ...upstream, args: ["different"] }, verifyUpstream: true,
    }).initialize()).rejects.toThrow("different upstream");
  });

  test("does not treat a missing or corrupt source notebook as an empty investigation", async () => {
    const recorder = await setup();
    await recorder.execute(request, async () => success);
    await writeFile(recorder.notebookPath, "{broken");
    const reader = new Recorder(join(recorder.directory, ".."), recorder.runId);
    await expect(reader.entries()).rejects.toThrow();
    await rm(recorder.notebookPath);
    await expect(reader.entries()).rejects.toThrow("missing");
  });

  test("detects external edits to a live notebook before executing another query", async () => {
    const recorder = await setup();
    await writeFile(recorder.notebookPath, (await readFile(recorder.notebookPath, "utf8")) + "\n");
    let executed = false;
    await expect(recorder.execute(request, async () => { executed = true; return success; })).rejects.toThrow("changed outside");
    expect(executed).toBe(false);
  });

  test("writes optional debug files but never uses them over authoritative notebook evidence", async () => {
    const recorder = await setup({ debugJson: true });
    const { entry } = await recorder.execute(request, async () => success);
    const debug = join(recorder.directory, "debug");
    expect((await readdir(debug)).sort()).toEqual([`${entry.id}.json`, `${entry.id}.started.json`].sort());
    expect(JSON.parse(await readFile(join(debug, `${entry.id}.started.json`), "utf8")).status).toBe("started");
    await writeFile(join(debug, `${entry.id}.json`), "{broken");
    expect((await recorder.entries())[0]).toMatchObject({ id: entry.id, status: "succeeded", result: success });
  });

  test("does not fall back to debug copies if the authoritative notebook is corrupt", async () => {
    const recorder = await setup({ debugJson: true });
    await recorder.execute(request, async () => success);
    await writeFile(recorder.notebookPath, "{broken");
    const reader = new Recorder(join(recorder.directory, ".."), recorder.runId);
    await expect(reader.entries()).rejects.toThrow();
  });

  test("reports optional debug failures without losing notebook evidence", async () => {
    const recorder = await setup({ debugJson: true });
    await writeFile(join(recorder.directory, "debug"), "not a directory");
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await recorder.execute(request, async () => success);
      expect(errors).toHaveBeenCalled();
      expect((await recorder.entries())[0]).toMatchObject({ status: "succeeded", result: success });
    } finally {
      errors.mockRestore();
    }
  });

  test("records query-payload failures as failed executions", async () => {
    const recorder = await setup();
    const result = { content: [{ type: "text" as const, text: '{"status":403,"message":"Denied"}' }] };
    const { entry } = await recorder.execute(request, async () => result);
    expect(entry.status).toBe("tool_error");
    expect((await recorder.entries())[0]).toMatchObject({ status: "tool_error", result });
  });

  test("migrates older notebook cell metadata without losing original requests", async () => {
    const recorder = await setup();
    const entry: Execution = { type: "execution", id: "E-abcd", startedAt: "2026-01-01T00:00:00Z", status: "succeeded", request, result: success };
    await writeFile(recorder.notebookPath, JSON.stringify({
      nbformat: 4, metadata: { kusto_recorder: { run_id: recorder.runId, notes: [] } },
      cells: [{ id: entry.id, metadata: { evidence_id: entry.id, kusto_recorder: entry } }],
    }));
    const reopened = new Recorder(join(recorder.directory, ".."), recorder.runId);
    await reopened.initialize();
    expect(await reopened.entries()).toEqual([entry]);
    expect(JSON.parse(await readFile(recorder.notebookPath, "utf8")).metadata.kusto_recorder.format_version).toBe(2);
  });

  test("serializes pending and complete writes while a different reader snapshots the notebook", async () => {
    const recorder = await setup();
    const reader = new Recorder(join(recorder.directory, ".."), recorder.runId);
    const completed = await Promise.allSettled([
      ...Array.from({ length: 12 }, () => recorder.execute(request, async () => success)),
      ...Array.from({ length: 12 }, () => reader.entries()),
    ]);
    expect(completed.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await reader.entries()).toHaveLength(12);
    expect((await reader.entries()).every((entry) => entry.type === "execution" && entry.status === "succeeded")).toBe(true);
  });

  test("prefixes every intent line as a KQL comment without altering original evidence", () => {
    const intent = "Check failures\r\n| take 999\u2028Compare regions";
    const original = { ...request, arguments: { ...request.arguments, intent } };
    const notebook = makeNotebook("example", [{
      type: "execution", id: "E-abcd", startedAt: "2026-01-01T00:00:00Z", status: "succeeded", request: original, result: success,
    }]);
    expect(notebook.cells[2].source).toBe('%%kusto\n// Intent: Check failures\n// Intent: | take 999\n// Intent: Compare regions\nprint text = "hello"');
    expect(original.arguments.parameters.query).toBe('print text = "hello"');
    expect(notebook.metadata.kusto_recorder.entries[0]).toMatchObject({ request: original });
  });

  test("does not add the same intent twice when a commented query is replayed", () => {
    const commented = { ...request, arguments: {
      ...request.arguments, intent: "Check failures",
      parameters: { ...request.arguments.parameters, query: "// Intent: Check failures\nprint 1" },
    } };
    const notebook = makeNotebook("example", [{
      type: "execution", id: "E-abcd", startedAt: "2026-01-01T00:00:00Z", status: "succeeded", request: commented, result: success,
    }]);
    expect(notebook.cells[2].source).toBe("%%kusto\n// Intent: Check failures\nprint 1");
  });
});
