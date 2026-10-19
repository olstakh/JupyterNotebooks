import { replay } from "./adapters/mcp-replay.js";

export { replay };

if (import.meta.main) await replay();
