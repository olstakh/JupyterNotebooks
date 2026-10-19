import { Recorder } from "./recorder.js";
import { mcpAdapter } from "./adapters/mcp.js";
import { jsonValue } from "./model.js";
import type { ReplayUpstream } from "./config.js";

export function createRecorder(root: string, runId: string, options: {
  debugJson?: boolean;
  upstream?: ReplayUpstream;
  verifyUpstream?: boolean;
} = {}): Recorder {
  return new Recorder(root, runId, {
    debugJson: options.debugJson,
    adapters: [mcpAdapter],
    configurations: { mcp: options.upstream === undefined ? null : jsonValue(options.upstream) },
    verifyConfigurations: options.verifyUpstream || options.upstream !== undefined,
  });
}
