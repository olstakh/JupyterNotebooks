import {
  type Entry, type Execution, type ExecutionView, type JsonObject,
  type NotebookAdapter, type NotebookOutput,
} from "./model.js";

type Cell = {
  id: string;
  cell_type: "markdown" | "code";
  metadata: Record<string, unknown>;
  source: string;
  execution_count?: number | null;
  outputs?: NotebookOutput[];
};

export type NotebookOptions = {
  adapters?: readonly NotebookAdapter[];
  configurations?: JsonObject;
};

function markdown(id: string, source: string): Cell {
  return { id, cell_type: "markdown", metadata: {}, source };
}

function outputs(entry: Execution, view: ExecutionView): NotebookOutput[] {
  if (view.outputs) return view.outputs;
  if (entry.result !== undefined) {
    if (entry.status === "failed") {
      const message = `Recorded ${entry.adapter} execution failed:\n${JSON.stringify(entry.result, null, 2)}`;
      return [{ output_type: "error", ename: "RecordedExecutionError", evalue: message, traceback: [message] }];
    }
    return [{
      output_type: "display_data",
      data: { "text/plain": JSON.stringify(entry.result, null, 2) },
      metadata: {},
    }];
  }
  return [{
    output_type: "stream", name: "stderr",
    text: entry.error
      ? `Execution outcome uncertain: ${entry.error}`
      : "Execution started; no outcome recorded. It may have reached Kusto. Do not assume it is safe to retry.",
  }];
}

export function makeNotebook(runId: string, entries: Entry[], options: NotebookOptions = {}) {
  const adapters = new Map((options.adapters ?? []).map((adapter) => [adapter.id, adapter]));
  const configurations = options.configurations ?? {};
  const cells: Cell[] = [];
  const connections = new Map<string, Record<string, JsonObject>>();
  const keys = new Map<string, string>();
  let executionCount = 0;
  let omittedCalls = 0;
  for (const entry of entries) {
    if (entry.type !== "execution") continue;
    const adapter = adapters.get(entry.adapter);
    if (adapter) adapter.validateEntry(entry);
    const view = adapter?.describe(entry) ?? {};
    if (view.hidden) {
      omittedCalls++;
      continue;
    }
    let source = view.source;
    if (view.query) {
      const key = JSON.stringify([entry.adapter, view.query.connection]);
      let name = keys.get(key);
      if (!name) {
        name = `connection${keys.size + 1}`;
        keys.set(key, name);
        const group = connections.get(entry.adapter) ?? {};
        group[name] = view.query.connection;
        connections.set(entry.adapter, group);
      }
      const comment = view.intent?.trim()
        ? view.intent.trim().split(/\r\n|[\r\n\u0085\u2028\u2029]/u).map((line) => `// Intent: ${line}`).join("\n") : "";
      const alreadyCommented = comment && (view.query.text === comment || view.query.text.startsWith(`${comment}\n`) || view.query.text.startsWith(`${comment}\r\n`));
      const query = comment && !alreadyCommented ? `${comment}\n${view.query.text}` : view.query.text;
      source = `%%${view.query.magic}${name === "connection1" ? "" : ` ${name}`}\n${query}`;
    }
    if (!source) {
      cells.push(markdown(`${entry.id}-request`, `### Recorded ${entry.adapter} request\n\n\`\`\`json\n${JSON.stringify(entry.request, null, 2)}\n\`\`\``));
      source = `raise RuntimeError(${JSON.stringify(`No replay adapter is installed for "${entry.adapter}". Evidence is preserved; this cell cannot be replayed.`)})`;
    }
    cells.push({
      id: entry.id, cell_type: "code",
      metadata: { evidence_id: entry.id, recorded_status: entry.status },
      source, execution_count: entry.status === "started" ? null : ++executionCount,
      outputs: outputs(entry, view),
    });
  }
  const setupCells: Cell[] = [];
  const metadata: JsonObject = {};
  const activeAdapters = [...adapters.values()].filter((adapter) =>
    configurations[adapter.id] !== undefined || entries.some((entry) => entry.type === "execution" && entry.adapter === adapter.id),
  );
  for (const adapter of activeAdapters) {
    const configuration = configurations[adapter.id];
    adapter.validateConfiguration(configuration);
    Object.assign(metadata, adapter.metadata(configuration));
    setupCells.push({
      id: activeAdapters.length === 1 ? "replay-setup" : `replay-setup-${adapter.id}`,
      cell_type: "code",
      metadata: { jupyter: { source_hidden: true }, tags: ["hide-input"] },
      source: adapter.setup(connections.get(adapter.id) ?? {}, configuration),
      execution_count: null, outputs: [],
    });
  }
  cells.unshift(
    markdown("overview", "# Kusto investigation\n\nRun the setup cell once, then run or edit the queries below. Saved outputs show the original run; replay fetches live data. Review recorded commands and requests before replay. Evidence without an installed adapter remains readable but cannot be replayed."),
    ...setupCells,
  );
  return {
    nbformat: 4, nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python" },
      kusto_recorder: {
        ...metadata,
        format_version: 3, run_id: runId, adapter_configurations: configurations,
        entries, omitted_discovery_calls: omittedCalls,
      },
    },
    cells,
  };
}
