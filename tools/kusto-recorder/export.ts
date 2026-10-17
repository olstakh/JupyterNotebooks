import { resolve } from "node:path";
import { snapshotEvidence } from "./evidence.js";
import { projectRoot } from "./config.js";

try {
  const runId = process.argv[2];
  if (!runId) throw new Error("Usage: bun run export:notebook <run-id>");
  const result = await snapshotEvidence(resolve(projectRoot, process.env.KUSTO_RECORDING_DIR ?? ".investigations"), runId);
  console.log(result.notebook);
} catch (error) {
  console.error("Notebook export failed:", error);
  process.exitCode = 1;
}
