import { resolve } from "node:path";

export const projectRoot = resolve(import.meta.dir, "..", "..");

export function recordingRoot(value = process.env.KUSTO_RECORDING_DIR, cwd = process.cwd()): string {
  if (value !== undefined && !value.trim()) throw new Error("KUSTO_RECORDING_DIR must not be empty.");
  return resolve(cwd, value ?? ".investigations");
}

export type ReplayUpstream = {
  command: string;
  args: string[];
  cwd: string;
};

export function parseReplayUpstream(value: unknown): ReplayUpstream {
  if (typeof value !== "object" || value === null
    || !("command" in value) || typeof value.command !== "string" || !value.command.trim()
    || !("args" in value) || !Array.isArray(value.args) || !value.args.every((arg): arg is string => typeof arg === "string")
    || !("cwd" in value) || typeof value.cwd !== "string" || !value.cwd.trim()) {
    throw new Error("Invalid upstream launch settings: expected command, args, and cwd.");
  }
  return { command: value.command, args: value.args, cwd: value.cwd };
}

export function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
