export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Array.from(value, jsonValue);
  if (isObject(value)) return jsonObject(value);
  throw new Error("Evidence must contain only JSON values.");
}

export function jsonObject(value: unknown): JsonObject {
  if (!isObject(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error("Expected a plain JSON object.");
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
}

export type Execution = {
  type: "execution";
  id: string;
  adapter: string;
  startedAt: string;
  finishedAt?: string;
  status: "started" | "succeeded" | "failed" | "transport_error";
  request: JsonValue;
  result?: JsonValue;
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

export type NotebookOutput =
  | { output_type: "display_data"; data: Record<string, string>; metadata: JsonObject }
  | { output_type: "error"; ename: string; evalue: string; traceback: string[] }
  | { output_type: "stream"; name: "stderr"; text: string };

export type ExecutionView = {
  hidden?: boolean;
  intent?: string;
  query?: { text: string; magic: string; connection: JsonObject };
  source?: string;
  outputs?: NotebookOutput[];
};

export interface ExecutionAdapter<Request, Result> {
  readonly id: string;
  captureRequest(request: Request): JsonValue;
  captureResult(result: Result): JsonValue;
  isError(result: Result): boolean;
}

export interface NotebookAdapter {
  readonly id: string;
  validateEntry(entry: Execution): void;
  validateConfiguration(configuration: JsonValue | undefined): void;
  describe(entry: Execution): ExecutionView;
  setup(connections: Record<string, JsonObject>, configuration: JsonValue | undefined): string;
  metadata(configuration: JsonValue | undefined): JsonObject;
}

export function parseEntry(value: unknown, legacy = false): Entry {
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
  const adapter = legacy && value.adapter === undefined ? "mcp" : value.adapter;
  if (typeof adapter !== "string" || !/^[a-z][a-z0-9_-]*$/.test(adapter)) throw new Error("Invalid evidence adapter ID.");
  const status = legacy && value.status === "tool_error" ? "failed" : value.status;
  const { finishedAt, error } = value;
  if (status !== "started" && status !== "succeeded" && status !== "failed" && status !== "transport_error") {
    throw new Error(`Invalid execution status for ${value.id}.`);
  }
  if (finishedAt !== undefined && (typeof finishedAt !== "string" || !Number.isFinite(Date.parse(finishedAt)))) {
    throw new Error(`Invalid completion time for ${value.id}.`);
  }
  if (error !== undefined && typeof error !== "string") throw new Error(`Invalid error for ${value.id}.`);
  if ((status === "succeeded" || status === "failed") && value.result === undefined) throw new Error(`Missing response for ${value.id}.`);
  if (status === "transport_error" && typeof error !== "string") throw new Error(`Missing transport error for ${value.id}.`);
  return {
    type: "execution", id: value.id, adapter, startedAt: value.startedAt, status, request: jsonValue(value.request),
    ...(typeof finishedAt === "string" ? { finishedAt } : {}),
    ...(typeof error === "string" ? { error } : {}),
    ...(value.result !== undefined ? { result: jsonValue(value.result) } : {}),
  };
}
