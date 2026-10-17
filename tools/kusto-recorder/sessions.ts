import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { atomicWrite, Recorder } from "./recorder.js";

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
  await mkdir(directory, { recursive: true });
  const previous = await readSession(directory);
  if (isSessionActive(previous)) throw new Error(`Recorder run already has an active writer: ${directory}`);
  if (previous) await new Recorder(dirname(directory), basename(directory)).entries();
  const lockPath = join(directory, ".writer.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`Recorder run is locked: ${directory}. Use a different run ID. After a crash, remove .writer.lock only after confirming its owning process has exited.`);
    }
    throw error;
  }
  const session: Session = { pid: process.pid, startedAt: new Date().toISOString() };
  try {
    try {
      await lock.writeFile(JSON.stringify(session), "utf8");
      await lock.sync();
    } finally {
      await lock.close();
    }
    await atomicWrite(join(directory, "session.json"), JSON.stringify(session, null, 2));
  } catch (error) {
    await unlink(lockPath);
    throw error;
  }
  let finished = false;
  return async () => {
    if (finished) return;
    finished = true;
    try {
      await atomicWrite(join(directory, "session.json"), JSON.stringify({
        ...session, endedAt: new Date().toISOString(),
      }, null, 2));
    } finally {
      await unlink(lockPath);
    }
  };
}
