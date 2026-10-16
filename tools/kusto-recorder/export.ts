import { resolve } from "node:path";
import { Recorder } from "./recorder.js";
import { projectRoot } from "./config.js";

try {
  const runId = process.argv[2];
  if (!runId) throw new Error("Usage: bun run export:notebook <run-id>");
  const recorder = new Recorder(resolve(projectRoot, process.env.KUSTO_RECORDING_DIR ?? ".investigations"), runId);
  await recorder.exportNotebook();
  console.log(recorder.notebookPath);
} catch (error) {
  console.error("Notebook export failed:", error);
  process.exitCode = 1;
}
