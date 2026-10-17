import type { Entry, Execution } from "./recorder.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { azureMcpVersion, projectRoot, type ReplayUpstream } from "./config.js";

type Cell = {
  id: string;
  cell_type: "markdown" | "code";
  metadata: Record<string, unknown>;
  source: string;
  execution_count?: number | null;
  outputs?: unknown[];
};

type Connection = {
  tool: string;
  router: boolean;
  parameters: Record<string, unknown>;
};

function setupSource(connections: Record<string, Connection>, upstream?: ReplayUpstream): string {
  return `# Run once to enable %%kusto and %%mcp. Kqlmagic is not required.
import importlib.util
import json
import os
from pathlib import Path

_root = Path(os.environ.get("KUSTO_RECORDER_ROOT", Path.cwd())).resolve()
_root = next((p for p in [_root, *_root.parents, Path(${JSON.stringify(projectRoot)})]
              if (p / "tools" / "kusto-recorder" / "kusto_notebook.py").is_file()), _root)
_helper = _root / "tools" / "kusto-recorder" / "kusto_notebook.py"
if not _helper.is_file():
    raise FileNotFoundError("Set KUSTO_RECORDER_ROOT to the recorder project directory.")
_spec = importlib.util.spec_from_file_location("kusto_notebook", _helper)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
_replay_run = _module.register(get_ipython(), _root, json.loads(${JSON.stringify(JSON.stringify(connections))}), upstream=json.loads(${JSON.stringify(JSON.stringify(upstream ?? null))}))
`;
}

function markdown(id: string, source: string): Cell {
  return { id, cell_type: "markdown", metadata: {}, source };
}

function queryDetails(entry: Execution): { query: string; connection: Connection } | undefined {
  const args = entry.request.arguments;
  if (args?.learn) return undefined;
  const command = args?.command ?? entry.request.name;
  if (command !== "kusto_query" && command !== "kusto_sample") return undefined;
  const router = args?.command !== undefined;
  const parameters = router ? args?.parameters : args;
  if (!isObject(parameters)) return undefined;
  const { query, table, limit, ...target } = parameters;
  const text = command === "kusto_query" ? query
    : typeof table === "string" ? `table(${JSON.stringify(table)})\n| take ${typeof limit === "number" ? limit : 10}` : undefined;
  if (typeof text !== "string") return undefined;
  return {
    query: text,
    connection: {
      tool: entry.request.name === "kusto_sample" ? "kusto_query" : entry.request.name,
      router,
      parameters: Object.fromEntries(Object.entries(target).sort(([a], [b]) => a.localeCompare(b))),
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[character];
  });
}

function payloads(result: CallToolResult): unknown[] {
  const values: unknown[] = [];
  for (const block of result.content) {
    if (block.type !== "text") continue;
    let payload: unknown;
    try {
      payload = JSON.parse(block.text);
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    values.push(payload);
  }
  return values;
}

export function isQueryError(result: CallToolResult): boolean {
  return result.isError === true || payloads(result).some((payload) =>
    isObject(payload) && typeof payload.status === "number" && payload.status >= 400,
  );
}

function resultText(result: CallToolResult): string {
  const text = result.content.filter((block) => block.type === "text" && !block.text.startsWith("Recorder evidence ID:"))
    .map((block) => block.type === "text" ? block.text : "").join("\n");
  return text || JSON.stringify(result.structuredContent ?? result.content, null, 2);
}

export function renderResult(result: CallToolResult) {
  if (isQueryError(result)) {
    const message = resultText(result);
    return { output_type: "error", ename: "KustoQueryError", evalue: message, traceback: [message] };
  }
  let html = "";
  let plain = "";
  for (const payload of payloads(result)) {
    if (!isObject(payload) || !isObject(payload.results) || !Array.isArray(payload.results.items)) continue;
    const [schema, ...rows] = payload.results.items;
    if (!isObject(schema) || !rows.every(Array.isArray)) continue;
    const columns = Object.keys(schema);
    html += `<table><thead><tr>${columns.map((name) => `<th>${escapeHtml(name)}</th>`).join("")}</tr></thead><tbody>`;
    plain += `${columns.join("\t")}\n`;
    for (const row of rows.slice(0, 100)) {
      const values = columns.map((_, index) => typeof row[index] === "object" ? JSON.stringify(row[index]) : String(row[index]));
      html += `<tr>${values.map((value) => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`;
      plain += `${values.join("\t")}\n`;
    }
    html += "</tbody></table>";
    if (rows.length > 100) {
      const warning = `Showing 100 of ${rows.length} returned rows. Full response is preserved in notebook metadata.`;
      html += `<p>${warning}</p>`;
      plain += `${warning}\n`;
    }
    if (typeof payload.message === "string" && payload.message !== "Success") {
      html += `<p>${escapeHtml(payload.message)}</p>`;
      plain += `${payload.message}\n`;
    }
  }
  if (!html) {
    plain = resultText(result);
    html = `<pre>${escapeHtml(plain)}</pre>`;
  }
  return { output_type: "display_data", data: { "text/html": html, "text/plain": plain }, metadata: {} };
}

function outputs(entry: Execution): unknown[] {
  if (entry.result) {
    return [renderResult(entry.result)];
  }
  return [{
    output_type: "stream",
    name: "stderr",
    text: entry.error
      ? `Execution outcome uncertain: ${entry.error}`
      : "Execution started; no outcome recorded. It may have reached Kusto. Do not assume it is safe to retry.",
  }];
}

export function makeNotebook(runId: string, entries: Entry[], upstream?: ReplayUpstream) {
  const cells: Cell[] = [];
  const connections: Record<string, Connection> = {};
  const keys = new Map<string, string>();
  let executionCount = 0;
  for (const entry of entries) {
    if (entry.type !== "execution") continue;
    const details = queryDetails(entry);
    if (!details) {
      if (entry.request.arguments?.learn === true) continue;
      cells.push({
        id: entry.id, cell_type: "code",
        metadata: { evidence_id: entry.id, recorded_status: entry.status },
        source: `%%mcp\n${JSON.stringify(entry.request, null, 2)}`,
        execution_count: entry.status === "started" ? null : ++executionCount,
        outputs: outputs(entry),
      });
      continue;
    }
    const key = JSON.stringify(details.connection);
    let name = keys.get(key);
    if (!name) {
      name = `connection${keys.size + 1}`;
      keys.set(key, name);
      connections[name] = details.connection;
    }
    const intent = entry.request.arguments?.intent;
    const comment = typeof intent === "string" && intent.trim()
      ? intent.trim().split(/\r\n|[\r\n\u0085\u2028\u2029]/u).map((line) => `// Intent: ${line}`).join("\n") : "";
    const alreadyCommented = comment && (details.query === comment || details.query.startsWith(`${comment}\n`) || details.query.startsWith(`${comment}\r\n`));
    const query = comment && !alreadyCommented ? `${comment}\n${details.query}` : details.query;
    const source = `%%kusto${name === "connection1" ? "" : ` ${name}`}\n${query}`;
    cells.push({
      id: entry.id, cell_type: "code",
      metadata: {
        evidence_id: entry.id,
        recorded_status: entry.status,
      },
      source, execution_count: entry.status === "started" ? null : ++executionCount, outputs: outputs(entry),
    });
  }
  cells.unshift(
    markdown("overview", "# Kusto investigation\n\nRun the setup cell once, then run or edit the queries below. Saved outputs show the original run; replay fetches live data. Unrecognized tool formats use editable %%mcp request cells. Review recorded commands and requests before replay."),
    {
      id: "replay-setup", cell_type: "code",
      metadata: { jupyter: { source_hidden: true }, tags: ["hide-input"] },
      source: setupSource(connections, upstream), execution_count: null, outputs: [],
    },
  );
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python" },
      kusto_recorder: {
        format_version: 2,
        run_id: runId, ...(upstream ? { upstream } : { upstream_version: azureMcpVersion }), entries,
        omitted_discovery_calls: entries.filter((entry) => entry.type === "execution" && entry.request.arguments?.learn === true).length,
      },
    },
    cells,
  };
}
