import type { CallToolRequest, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { inheritedEnvironment, parseReplayUpstream, projectRoot, type ReplayUpstream } from "../config.js";
import {
  isObject, jsonObject, jsonValue,
  type Execution, type ExecutionAdapter, type ExecutionView, type JsonObject,
  type JsonValue, type NotebookAdapter, type NotebookOutput,
} from "../model.js";

export const azureMcpVersion = "3.0.0";

export function upstreamConfig(args = process.argv.slice(2)): StdioServerParameters {
  if (args.length) {
    const original = args[0] === "--" ? args.slice(1) : args;
    if (!original[0]?.trim() || original[0].startsWith("-")) {
      throw new Error("Usage: bootstrap.ts -- <original MCP command> [original arguments...]");
    }
    return { command: original[0], args: original.slice(1), cwd: process.cwd(), env: inheritedEnvironment(), stderr: "inherit" };
  }
  return {
    command: process.execPath,
    args: ["x", `@azure/mcp@${azureMcpVersion}`, "server", "start", "--namespace", "kusto", "--read-only"],
    cwd: process.cwd(), env: inheritedEnvironment(), stderr: "inherit",
  };
}

function setupSource(connections: Record<string, JsonObject>, upstream?: ReplayUpstream): string {
  return `# Run once to enable %%kusto and %%mcp. Kqlmagic is not required.
import importlib.util
import json
import os
import subprocess
from pathlib import Path

_root = Path(os.environ.get("KUSTO_RECORDER_ROOT", Path.cwd())).resolve()
_root = next((p for p in [_root, *_root.parents, Path(${JSON.stringify(projectRoot)})]
              if (p / "tools" / "kusto-recorder" / "kusto_notebook.py").is_file()), _root)
_helper = _root / "tools" / "kusto-recorder" / "kusto_notebook.py"
if not _helper.is_file():
    _located = subprocess.run(
        ["bun", "x", "--no-install", "kusto-recorder", "helper-path"],
        capture_output=True, text=True, encoding="utf-8", timeout=30)
    if _located.returncode != 0:
        raise RuntimeError("Install kusto-investigation-recorder in this repository, or set KUSTO_RECORDER_ROOT to its installed package directory.\\n" + _located.stderr)
    _helper = Path(_located.stdout.strip()).resolve()
    if not _helper.is_file():
        raise FileNotFoundError("The installed recorder returned a missing notebook helper: " + str(_helper))
    _root = _helper.parents[2]
_spec = importlib.util.spec_from_file_location("kusto_notebook", _helper)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
_replay_run = _module.register(get_ipython(), _root, json.loads(${JSON.stringify(JSON.stringify(connections))}), upstream=json.loads(${JSON.stringify(JSON.stringify(upstream ?? null))}))
`;
}

function queryDetails(request: CallToolRequest["params"]): ExecutionView["query"] | undefined {
  const args = request.arguments;
  if (args?.learn) return undefined;
  const command = args?.command ?? request.name;
  if (command !== "kusto_query" && command !== "kusto_sample") return undefined;
  const router = args?.command !== undefined;
  const parameters = router ? args?.parameters : args;
  if (!isObject(parameters)) return undefined;
  const { query, table, limit, ...target } = parameters;
  const text = command === "kusto_query" ? query
    : typeof table === "string" ? `table(${JSON.stringify(table)})\n| take ${typeof limit === "number" ? limit : 10}` : undefined;
  if (typeof text !== "string") return undefined;
  return {
    text, magic: "kusto",
    connection: jsonObject({
      tool: request.name === "kusto_sample" ? "kusto_query" : request.name,
      router,
      parameters: Object.fromEntries(Object.entries(target).sort(([a], [b]) => a.localeCompare(b))),
    }),
  };
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
    try {
      values.push(JSON.parse(block.text));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
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

export function renderResult(result: CallToolResult): NotebookOutput {
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

export const mcpAdapter: ExecutionAdapter<CallToolRequest["params"], CallToolResult> & NotebookAdapter = {
  id: "mcp",
  captureRequest(request) {
    return jsonValue(CallToolRequestSchema.parse({ method: "tools/call", params: request }).params);
  },
  captureResult(result) {
    return jsonValue(CallToolResultSchema.parse(result));
  },
  isError: isQueryError,
  validateEntry(entry: Execution) {
    CallToolRequestSchema.parse({ method: "tools/call", params: entry.request });
    if (entry.result !== undefined) CallToolResultSchema.parse(entry.result);
  },
  validateConfiguration(configuration: JsonValue | undefined) {
    if (configuration === undefined) throw new Error("MCP replay configuration is missing.");
    if (configuration !== null) parseReplayUpstream(configuration);
  },
  describe(entry) {
    const request = CallToolRequestSchema.parse({ method: "tools/call", params: entry.request }).params;
    const intent = request.arguments?.intent;
    return {
      hidden: request.arguments?.learn === true,
      query: queryDetails(request),
      source: `%%mcp\n${JSON.stringify(request, null, 2)}`,
      ...(typeof intent === "string" ? { intent } : {}),
      ...(entry.result !== undefined ? { outputs: [renderResult(CallToolResultSchema.parse(entry.result))] } : {}),
    };
  },
  setup(connections, configuration) {
    return setupSource(connections, configuration == null ? undefined : parseReplayUpstream(configuration));
  },
  metadata(configuration): JsonObject {
    if (configuration == null) return { upstream_version: azureMcpVersion };
    return { upstream: jsonValue(parseReplayUpstream(configuration)) };
  },
};
