import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { CallToolRequest, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { isQueryError, makeNotebook } from "./notebook.js";
import { parseReplayUpstream, type ReplayUpstream } from "./config.js";

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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function parseEntry(value: unknown): Entry {
  if (!isObject(value) || typeof value.id !== "string" || typeof value.startedAt !== "string"
    || !Number.isFinite(Date.parse(value.startedAt))) throw new Error("Invalid notebook evidence entry.");
  if (value.type === "note" && /^N-[\da-f-]+$/.test(value.id)) {
    const { kind, text, evidenceIds } = value;
    if ((kind !== "plan" && kind !== "observation" && kind !== "conclusion") || typeof text !== "string"
      || !Array.isArray(evidenceIds) || !evidenceIds.every((id): id is string => typeof id === "string")) {
      throw new Error(`Invalid notebook note ${value.id}.`);
    }
    return { type: "note", id: value.id, startedAt: value.startedAt, kind, text, evidenceIds };
  }
  if (value.type !== "execution" || !/^E-[\da-f-]+$/.test(value.id)) throw new Error("Invalid notebook evidence type or ID.");
  const { status, finishedAt, error } = value;
  if (status !== "started" && status !== "succeeded" && status !== "tool_error" && status !== "transport_error") {
    throw new Error(`Invalid execution status for ${value.id}.`);
  }
  if (finishedAt !== undefined && (typeof finishedAt !== "string" || !Number.isFinite(Date.parse(finishedAt)))) {
    throw new Error(`Invalid completion time for ${value.id}.`);
  }
  if (error !== undefined && typeof error !== "string") throw new Error(`Invalid error for ${value.id}.`);
  const request = CallToolRequestSchema.parse({ method: "tools/call", params: value.request }).params;
  const result = value.result === undefined ? undefined : CallToolResultSchema.parse(value.result);
  if ((status === "succeeded" || status === "tool_error") && !result) throw new Error(`Missing response for ${value.id}.`);
  if (status === "transport_error" && typeof error !== "string") throw new Error(`Missing transport error for ${value.id}.`);
  return {
    type: "execution", id: value.id, startedAt: value.startedAt, status, request,
    ...(typeof finishedAt === "string" ? { finishedAt } : {}),
    ...(typeof error === "string" ? { error } : {}),
    ...(result ? { result } : {}),
  };
}

function sorted(entries: Entry[]): Entry[] {
  return entries.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
}

function fingerprint(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx");
  try {
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, path);
        break;
      } catch (error) {
        const sharingViolation = process.platform === "win32" && error instanceof Error && "code" in error
          && (error.code === "EPERM" || error.code === "EACCES" || error.code === "EBUSY");
        if (!sharingViolation || attempt === 5) throw error;
        await new Promise((done) => setTimeout(done, 10 * 2 ** attempt));
      }
    }
  } catch (error) {
    await unlink(temporary);
    throw error;
  }
}

export class Recorder {
  readonly directory: string;
  readonly notebookPath: string;
  private queue: Promise<void> = Promise.resolve();
  private expectedFingerprint?: string;
  private upstream?: ReplayUpstream;

  constructor(root: string, readonly runId: string, private readonly options: { debugJson?: boolean; upstream?: ReplayUpstream; verifyUpstream?: boolean } = {}) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runId)) {
      throw new Error("Investigation ID must contain only letters, digits, underscores or hyphens (1-100 characters).");
    }
    this.directory = resolve(root, runId);
    this.notebookPath = join(this.directory, "investigation.ipynb");
    this.upstream = options.upstream;
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await this.serialize(async () => this.writeNotebook(await this.loadEntries(true)));
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.then(() => {}, () => {});
    return next;
  }

  private async loadEntries(allowNew = false): Promise<Entry[]> {
    let notebook: unknown;
    try {
      const contents = await readFile(this.notebookPath, "utf8");
      if (this.expectedFingerprint && fingerprint(contents) !== this.expectedFingerprint) {
        throw new Error("Live evidence notebook changed outside the recorder. Use snapshots for editing; recording stopped to avoid overwriting evidence.");
      }
      notebook = JSON.parse(contents);
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (this.expectedFingerprint) throw new Error("Live evidence notebook is missing; recording stopped.");
    }
    if (notebook !== undefined) {
      if (!isObject(notebook) || notebook.nbformat !== 4 || !isObject(notebook.metadata)
        || !isObject(notebook.metadata.kusto_recorder) || notebook.metadata.kusto_recorder.run_id !== this.runId
        || !Array.isArray(notebook.cells)) throw new Error("Invalid evidence notebook or run ID.");
      const metadata = notebook.metadata.kusto_recorder;
      if (metadata.format_version !== undefined) {
        if (metadata.format_version !== 2 || !Array.isArray(metadata.entries)) throw new Error("Unsupported or invalid evidence notebook format.");
        const upstream = metadata.upstream === undefined ? undefined : parseReplayUpstream(metadata.upstream);
        if ((this.options.verifyUpstream || this.options.upstream) && JSON.stringify(upstream) !== JSON.stringify(this.options.upstream)) {
          throw new Error("This investigation belongs to a different upstream MCP configuration. Use a new run ID.");
        }
        this.upstream = upstream;
        const entries = metadata.entries.map(parseEntry);
        if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error("Duplicate evidence IDs in notebook.");
        return sorted(entries);
      }
    }
    const entries: Entry[] = [];
    if (isObject(notebook) && isObject(notebook.metadata) && isObject(notebook.metadata.kusto_recorder)) {
      const metadata = notebook.metadata.kusto_recorder;
      if (Array.isArray(metadata.notes)) entries.push(...metadata.notes.map(parseEntry));
      if (Array.isArray(notebook.cells)) {
        for (const cell of notebook.cells) {
          if (isObject(cell) && isObject(cell.metadata) && cell.metadata.kusto_recorder !== undefined) {
            entries.push(parseEntry(cell.metadata.kusto_recorder));
          }
        }
      }
    }
    for (const directory of [this.directory, join(this.directory, "debug")]) {
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        if (directory !== this.directory && isMissing(error)) continue;
        throw error;
      }
      const files = names.filter((name) => /^[EN]-[\da-f-]+(?:\.started)?\.json$/.test(name));
      entries.push(...await Promise.all(files.map(async (name) => parseEntry(JSON.parse(await readFile(join(directory, name), "utf8"))))));
    }
    if (notebook === undefined && entries.length === 0 && !allowNew) {
      throw new Error("Evidence notebook is missing and no legacy/debug records are available to recover it.");
    }
    const latest = new Map<string, Entry>();
    for (const entry of entries) {
      if (!latest.has(entry.id) || entry.type === "note" || entry.status !== "started") latest.set(entry.id, entry);
    }
    if (isObject(notebook) && Array.isArray(notebook.cells)) {
      for (const cell of notebook.cells) {
        if (isObject(cell) && isObject(cell.metadata) && typeof cell.metadata.evidence_id === "string"
          && !latest.has(cell.metadata.evidence_id)) throw new Error("Legacy notebook requires its original JSON records for migration.");
      }
      if (isObject(notebook.metadata) && isObject(notebook.metadata.kusto_recorder)) {
        const omitted = notebook.metadata.kusto_recorder.omitted_discovery_calls;
        const visible = new Set(notebook.cells.filter(isObject).map((cell) => cell.id));
        if (typeof omitted === "number" && [...latest.values()].filter((entry) => entry.type === "execution" && !visible.has(entry.id)).length < omitted) {
          throw new Error("Legacy notebook requires its discovery JSON records for migration.");
        }
      }
    }
    return sorted([...latest.values()]);
  }

  async entries(): Promise<Entry[]> {
    await this.queue;
    return this.loadEntries();
  }

  async snapshotNotebook() {
    const entries = await this.entries();
    return makeNotebook(this.runId, entries, this.upstream);
  }

  private async writeNotebook(entries: Entry[]): Promise<void> {
    const contents = JSON.stringify(makeNotebook(this.runId, sorted(entries.map(parseEntry)), this.upstream), null, 2);
    await atomicWrite(this.notebookPath, contents);
    this.expectedFingerprint = fingerprint(contents);
  }

  private async save(entry: Entry): Promise<void> {
    await this.serialize(async () => {
      const entries = await this.loadEntries();
      await this.writeNotebook([...entries.filter((existing) => existing.id !== entry.id), entry]);
      if (this.options.debugJson) {
        try {
          const directory = join(this.directory, "debug");
          await mkdir(directory, { recursive: true });
          const suffix = entry.type === "execution" && entry.status === "started" ? ".started.json" : ".json";
          await atomicWrite(join(directory, `${entry.id}${suffix}`), JSON.stringify(entry, null, 2));
        } catch (error) {
          console.error("Optional debug JSON write failed; notebook evidence is saved.", error);
        }
      }
    });
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
      try {
        await this.save(entry);
      } catch (recordingError) {
        throw new Error(`Recording failed after upstream error (${entry.id}); the query may have reached Kusto. Upstream error: ${entry.error}`, { cause: recordingError });
      }
      throw new Error(`Upstream execution failed (${entry.id}); execution may have reached Kusto: ${entry.error}`);
    }
    entry.status = isQueryError(result) ? "tool_error" : "succeeded";
    entry.result = result;
    entry.finishedAt = new Date().toISOString();
    try {
      await this.save(entry);
    } catch (error) {
      throw new Error(`Recording failed after upstream execution (${entry.id}); results withheld.`, { cause: error });
    }
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
    return entry;
  }

  async exportNotebook(): Promise<void> {
    await this.serialize(async () => this.writeNotebook(await this.loadEntries()));
  }
}
