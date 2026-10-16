import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "./recorder.js";

export type Session = {
  pid: number;
  startedAt: string;
  endedAt?: string;
};

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function readSession(directory: string): Promise<Session | undefined> {
  let contents: string;
  try {
    contents = await readFile(join(directory, "session.json"), "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const value: unknown = JSON.parse(contents);
  if (typeof value !== "object" || value === null
    || !("pid" in value) || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid < 1
    || !("startedAt" in value) || typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))
    || ("endedAt" in value && (typeof value.endedAt !== "string" || !Number.isFinite(Date.parse(value.endedAt))))) {
    throw new Error(`Invalid session metadata in ${directory}`);
  }
  return {
    pid: value.pid, startedAt: value.startedAt,
    ...("endedAt" in value ? { endedAt: String(value.endedAt) } : {}),
  };
}

export function isSessionActive(session: Session | undefined): boolean {
  if (!session || session.endedAt) return false;
  try {
    process.kill(session.pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

export async function registerSession(directory: string): Promise<() => Promise<void>> {
  const session: Session = { pid: process.pid, startedAt: new Date().toISOString() };
  await atomicWrite(join(directory, "session.json"), JSON.stringify(session, null, 2));
  return async () => {
    await atomicWrite(join(directory, "session.json"), JSON.stringify({
      ...session, endedAt: new Date().toISOString(),
    }, null, 2));
  };
}
