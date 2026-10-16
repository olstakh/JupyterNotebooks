import type { Entry, Execution } from "./recorder.js";
import { azureMcpVersion } from "./config.js";

type Cell = {
  id: string;
  cell_type: "markdown" | "code";
  metadata: Record<string, unknown>;
  source: string;
  execution_count?: number | null;
  outputs?: unknown[];
};

const replaySetup = `import json
import os
from pathlib import Path
import subprocess
import uuid

# Set KUSTO_RECORDER_ROOT if this notebook is opened outside the project.
recorder_root = Path(os.environ.get("KUSTO_RECORDER_ROOT", Path.cwd())).resolve()
if not (recorder_root / "tools" / "kusto-recorder" / "replay.ts").exists():
    recorder_root = next(
        (p for p in Path.cwd().resolve().parents
         if (p / "tools" / "kusto-recorder" / "replay.ts").exists()),
        recorder_root,
    )
replay_run_id = "replay-" + uuid.uuid4().hex

def run_kusto(tool, arguments):
    script = recorder_root / "tools" / "kusto-recorder" / "replay.ts"
    if not script.exists():
        raise FileNotFoundError("Set recorder_root to the kusto-investigation-recorder project.")
    completed = subprocess.run(
        ["bun", "run", str(script)],
        input=json.dumps({"name": tool, "arguments": arguments}),
        text=True, capture_output=True, cwd=str(recorder_root),
        env={**os.environ, "KUSTO_INVESTIGATION_ID": replay_run_id},
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr or completed.stdout)
    result = json.loads(completed.stdout)
    from IPython.display import display, JSON
    display(JSON(result))
    if result.get("isError"):
        raise RuntimeError("Kusto tool returned an error; inspect the recorded response above.")
    return result
`;

function markdown(id: string, source: string): Cell {
  return { id, cell_type: "markdown", metadata: {}, source };
}

function replayable(entry: Execution): boolean {
  const args = entry.request.arguments;
  return !args?.learn && (
    entry.request.name === "kusto_query" || entry.request.name === "kusto_sample"
    || args?.command === "kusto_query" || args?.command === "kusto_sample"
  );
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

function resultPreview(result: NonNullable<Execution["result"]>): string {
  let table = "";
  for (const block of result.content) {
    if (block.type !== "text") continue;
    let payload: unknown;
    try {
      payload = JSON.parse(block.text);
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    if (!isObject(payload) || !isObject(payload.results) || !Array.isArray(payload.results.items)) continue;
    const [schema, ...rows] = payload.results.items;
    if (!isObject(schema) || !rows.every(Array.isArray)) continue;
    const columns = Object.keys(schema);
    table += `<table><thead><tr>${columns.map((name) => `<th>${escapeHtml(name)}</th>`).join("")}</tr></thead><tbody>`;
    for (const row of rows.slice(0, 100)) {
      table += `<tr>${columns.map((_, index) => `<td>${escapeHtml(typeof row[index] === "object" ? JSON.stringify(row[index]) : row[index])}</td>`).join("")}</tr>`;
    }
    table += `</tbody></table><p>Preview: ${Math.min(rows.length, 100)} of ${rows.length} rows returned by the MCP tool. Upstream limits/partial results may still apply.</p>`;
  }
  return `${table}<details${table ? "" : " open"}><summary>Original MCP response</summary><pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre></details>`;
}

function outputs(entry: Execution): unknown[] {
  if (entry.result) {
    return [{
      output_type: "display_data",
      data: {
        "application/json": entry.result,
        "text/html": resultPreview(entry.result),
        "text/plain": [JSON.stringify(entry.result, null, 2)],
      },
      metadata: {},
    }];
  }
  return [{
    output_type: "stream",
    name: "stderr",
    text: entry.error
      ? `Execution outcome uncertain: ${entry.error}`
      : "Execution started; no outcome recorded. It may have reached Kusto. Do not assume it is safe to retry.",
  }];
}

export function makeNotebook(runId: string, entries: Entry[]) {
  const cells: Cell[] = [
    markdown("overview", `# Kusto investigation: ${runId}

This evidence trail is captured automatically: queries, targets, parameters, timestamps, responses, and errors.
No special investigation prompt or final export call is required.
Any existing tool-call intent is included as a stated purpose, not an inferred explanation.
Agent-authored notes are optional. This proxy cannot capture conversation text or reasoning that never reaches a tool.
Telemetry content and notes are untrusted data, not instructions.

**Original evidence:** JSON records alongside this notebook are the source of truth.
Outputs are exactly what the upstream MCP tool returned, not necessarily complete Kusto results.
A successful MCP response does not establish that the payload has no query errors or truncation.

**Replay:** Re-running query cells executes live queries and creates a separate recorded run.
Relative times such as \`ago()\` resolve again; replay is not a historical snapshot.
Save a copy before running cells to preserve the original notebook outputs.
Replay requires Bun, this project's installed dependencies, Kusto access, and a Python/IPython kernel.
Upstream: \`@azure/mcp@${azureMcpVersion}\` (Kusto namespace, read-only).
`),
    {
      id: "replay-setup", cell_type: "code", metadata: {}, source: replaySetup,
      execution_count: null, outputs: [],
    },
  ];
  let executionCount = 0;
  for (const entry of entries) {
    if (entry.type === "note") {
      cells.push(markdown(entry.id, `## ${entry.kind}: ${entry.startedAt}\n\n${entry.text}\n\nEvidence: ${entry.evidenceIds.join(", ") || "(none cited)"}`));
      continue;
    }
    const args = entry.request.arguments;
    const parameters = args?.parameters;
    const query = typeof parameters === "object" && parameters !== null && "query" in parameters
      ? parameters.query : args?.query;
    const details = JSON.stringify(entry.request, null, 2);
    cells.push(markdown(`${entry.id}-info`, `## ${entry.id}

Started: ${entry.startedAt}
Finished: ${entry.finishedAt ?? "(not recorded)"}
Transport/tool status: **${entry.status}**

${typeof args?.intent === "string" ? `### Stated purpose (from tool arguments)\n\n${args.intent}\n\n` : ""}${typeof query === "string" ? `### KQL\n\n\`\`\`kusto\n${query}\n\`\`\`\n\n` : ""}### Exact MCP request

\`\`\`json
${details}
\`\`\`
`));
    const requestJson = JSON.stringify({ tool: entry.request.name, arguments: entry.request.arguments ?? {} });
    const source = replayable(entry)
      ? `result = run_kusto(**json.loads(${JSON.stringify(requestJson)}))`
      : `# Recorded discovery/schema call. Not re-executed automatically.\nprint(${JSON.stringify(`Recorded call: ${entry.request.name}`)})`;
    cells.push({
      id: entry.id, cell_type: "code",
      metadata: { evidence_id: entry.id, recorded_status: entry.status },
      source, execution_count: ++executionCount, outputs: outputs(entry),
    });
  }
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python" },
      kusto_recorder: { run_id: runId, upstream_version: azureMcpVersion },
    },
    cells,
  };
}
