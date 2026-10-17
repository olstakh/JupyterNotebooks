import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Recorder, atomicWrite } from "./recorder.js";
import { projectRoot } from "./config.js";
import { isMissing, isSessionActive, readSession } from "./sessions.js";

export type Run = {
  id: string;
  active: boolean;
  lastActivity: string;
  executions: number;
};

export async function listRuns(root: string): Promise<Run[]> {
  let directories;
  try {
    directories = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const runs: Run[] = [];
  for (const directory of directories) {
    if (!directory.isDirectory() || !/^[a-zA-Z0-9_-]{1,100}$/.test(directory.name)) continue;
    const recorder = new Recorder(root, directory.name);
    const names = await readdir(recorder.directory);
    if (!names.includes("session.json") && !names.includes("investigation.ipynb")
      && !names.some((name) => /^E-[\da-f-]+(?:\.started)?\.json$/.test(name))) continue;
    const session = await readSession(recorder.directory);
    const entries = await recorder.entries();
    const times = entries.map((entry) => entry.type === "execution" ? entry.finishedAt ?? entry.startedAt : entry.startedAt);
    const fallbackPath = names.includes("investigation.ipynb") ? recorder.notebookPath : recorder.directory;
    const fallback = session?.startedAt ?? (await stat(fallbackPath)).mtime.toISOString();
    runs.push({
      id: directory.name,
      active: isSessionActive(session),
      lastActivity: times.sort().at(-1) ?? fallback,
      executions: entries.filter((entry) => entry.type === "execution").length,
    });
  }
  return runs.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity) || a.id.localeCompare(b.id));
}

export function selectRun(runs: Run[], explicitId?: string): Run {
  if (explicitId) {
    const run = runs.find((candidate) => candidate.id === explicitId);
    if (!run) throw new Error(`No recorded run named "${explicitId}". Use bun run evidence --list.`);
    return run;
  }
  const active = runs.filter((run) => run.active);
  if (active.length > 1) {
    throw new Error(`Multiple recorder sessions are active; use bun run evidence --run <id>:\n${active.map((run) => run.id).join("\n")}`);
  }
  const selected = active[0] ?? runs.find((run) => run.executions > 0) ?? runs[0];
  if (!selected) throw new Error("No recorded investigations yet. Run a Kusto query through the configured MCP proxy first.");
  return selected;
}

export async function snapshotEvidence(root: string, runId: string): Promise<{ notebook: string; executions: number }> {
  const recorder = new Recorder(root, runId);
  const notebook = await recorder.snapshotNotebook();
  const path = join(recorder.directory, `snapshot-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.ipynb`);
  await atomicWrite(path, JSON.stringify(notebook, null, 2));
  return { notebook: path, executions: notebook.metadata.kusto_recorder.entries.filter((entry) => entry.type === "execution").length };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 1 && args[0] === "--list") && !(args.length === 2 && args[0] === "--run" && args[1])) {
      throw new Error("Usage: bun run evidence [--list | --run <id>]");
    }
    const root = resolve(projectRoot, process.env.KUSTO_RECORDING_DIR ?? ".investigations");
    const runs = await listRuns(root);
    if (args[0] === "--list") {
      if (!runs.length) console.log("No recorded investigations yet.");
      else console.table(runs);
    } else {
      const run = selectRun(runs, args[0] === "--run" ? args[1] : process.env.KUSTO_INVESTIGATION_ID);
      const snapshot = await snapshotEvidence(root, run.id);
      console.error(`${run.active ? "Active recorder session" : "Saved investigation"}: ${run.id}`);
      console.error(`${snapshot.executions} recorded tool call(s). Snapshot only; no Kusto queries executed.`);
      console.log(snapshot.notebook);
    }
  } catch (error) {
    console.error("Evidence export failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
