import { snapshotEvidence } from "./evidence.js";
import { recordingRoot } from "./config.js";

try {
  const runId = process.argv[2];
  if (!runId) throw new Error("Usage: bun run export:notebook <run-id>");
  const result = await snapshotEvidence(recordingRoot(), runId);
  console.log(result.notebook);
} catch (error) {
  console.error("Notebook export failed:", error);
  process.exitCode = 1;
}
