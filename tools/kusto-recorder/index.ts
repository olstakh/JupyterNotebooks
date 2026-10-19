import { randomUUID } from "node:crypto";
import { recordingRoot, upstreamConfig } from "./config.js";
import { Recorder } from "./recorder.js";
import { startProxy } from "./proxy.js";

const runId = process.env.KUSTO_INVESTIGATION_ID
  ?? `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const debug = process.env.KUSTO_DEBUG_JSON;
if (debug !== undefined && debug !== "0" && debug !== "1") throw new Error("KUSTO_DEBUG_JSON must be 0 or 1.");
try {
  const upstream = upstreamConfig();
  const recorder = new Recorder(recordingRoot(), runId, {
    debugJson: debug === "1",
    verifyUpstream: true,
    ...(process.argv.length > 2 ? {
      upstream: { command: upstream.command, args: upstream.args ?? [], cwd: upstream.cwd ?? process.cwd() },
    } : {}),
  });
  const proxy = await startProxy(recorder, upstream);
  console.error(`Kusto investigation notebook: ${recorder.notebookPath}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void proxy.close().then(() => process.exit(0), (error) => {
        console.error(error);
        process.exit(1);
      });
    });
  }
} catch (error) {
  console.error("Kusto recorder startup failed:", error);
  process.exitCode = 1;
}
