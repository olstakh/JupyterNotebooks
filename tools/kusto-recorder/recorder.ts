import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { CallToolRequest, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { makeNotebook } from "./notebook.js";

export type Execution = {
  type: "execution";
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: "started" | "succeeded" | "tool_error" | "transport_error";
  request: CallToolRequest["params"];
  result?: CallToolResult;
  error?: string;
};

export type InvestigationNote = {
  type: "note";
  id: string;
  startedAt: string;
  kind: "plan" | "observation" | "conclusion";
  text: string;
  evidenceIds: string[];
};

export type Entry = Execution | InvestigationNote;

export async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx");
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary);
    throw error;
  }
}

export class Recorder {
  readonly directory: string;
  readonly notebookPath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(root: string, readonly runId: string) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runId)) {
      throw new Error("Investigation ID must contain only letters, digits, underscores or hyphens (1-100 characters).");
    }
    this.directory = resolve(root, runId);
    this.notebookPath = join(this.directory, "investigation.ipynb");
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await this.exportNotebook();
  }

  private async save(entry: Entry): Promise<void> {
    const suffix = entry.type === "execution" && entry.status === "started" ? ".started.json" : ".json";
    await atomicWrite(join(this.directory, `${entry.id}${suffix}`), JSON.stringify(entry, null, 2));
  }

  async entries(): Promise<Entry[]> {
    const names = (await readdir(this.directory)).filter((name) => /^[EN]-[\da-f-]+(?:\.started)?\.json$/.test(name));
    const entries = await Promise.all(names.map(async (name) =>
      JSON.parse(await readFile(join(this.directory, name), "utf8")) as Entry,
    ));
    const latest = new Map<string, Entry>();
    for (const entry of entries) {
      if (!latest.has(entry.id) || entry.type === "note" || entry.status !== "started") latest.set(entry.id, entry);
    }
    return [...latest.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  }

  async execute(
    request: CallToolRequest["params"],
    invoke: () => Promise<CallToolResult>,
  ): Promise<{ entry: Execution; result: CallToolResult }> {
    const entry: Execution = {
      type: "execution",
      id: `E-${randomUUID()}`,
      startedAt: new Date().toISOString(),
      status: "started",
      request,
    };
    await this.save(entry);
    let result: CallToolResult;
    try {
      result = await invoke();
    } catch (error) {
      entry.status = "transport_error";
      entry.error = error instanceof Error ? error.message : String(error);
      entry.finishedAt = new Date().toISOString();
      await this.save(entry);
      await this.refreshNotebook();
      throw new Error(`Upstream execution failed (${entry.id}); execution may have reached Kusto: ${entry.error}`);
    }
    entry.status = result.isError ? "tool_error" : "succeeded";
    entry.result = result;
    entry.finishedAt = new Date().toISOString();
    try {
      await this.save(entry);
    } catch (error) {
      throw new Error(`Recording failed after upstream execution (${entry.id}); results withheld.`, { cause: error });
    }
    await this.refreshNotebook();
    return { entry, result };
  }

  async note(input: unknown): Promise<InvestigationNote> {
    if (typeof input !== "object" || input === null) throw new Error("Note arguments must be an object.");
    const { kind, text, evidence_ids } = input as Record<string, unknown>;
    if (kind !== "plan" && kind !== "observation" && kind !== "conclusion") throw new Error("Invalid note kind.");
    if (typeof text !== "string" || !text.trim() || text.length > 20000) throw new Error("Note text must contain 1-20000 characters.");
    if (evidence_ids !== undefined && (!Array.isArray(evidence_ids) || !evidence_ids.every((id) => typeof id === "string"))) {
      throw new Error("evidence_ids must be an array of strings.");
    }
    const evidenceIds: string[] = evidence_ids ?? [];
    const known = new Set((await this.entries()).filter((entry) => entry.type === "execution").map((entry) => entry.id));
    if (evidenceIds.some((id) => !known.has(id))) throw new Error("Note references an unknown evidence ID.");
    const entry: InvestigationNote = {
      type: "note", id: `N-${randomUUID()}`, startedAt: new Date().toISOString(), kind, text, evidenceIds,
    };
    await this.save(entry);
    await this.refreshNotebook();
    return entry;
  }

  async exportNotebook(): Promise<void> {
    const next = this.queue.then(async () => {
      const notebook = makeNotebook(this.runId, await this.entries());
      await atomicWrite(this.notebookPath, JSON.stringify(notebook, null, 2));
    });
    this.queue = next.catch(() => {});
    await next;
  }

  private async refreshNotebook(): Promise<void> {
    try {
      await this.exportNotebook();
    } catch (error) {
      console.error(`Notebook export failed; durable records are preserved in ${this.directory}.`, error);
    }
  }
}
