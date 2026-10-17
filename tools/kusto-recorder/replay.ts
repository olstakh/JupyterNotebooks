import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolRequestSchema, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { join } from "node:path";
import { inheritedEnvironment, parseReplayUpstream, projectRoot } from "./config.js";
import { isQueryError, renderResult } from "./notebook.js";

const client = new Client({ name: "kusto-notebook-replay", version: "0.1.0" });
const upstream = process.env.KUSTO_REPLAY_UPSTREAM === undefined ? undefined
  : parseReplayUpstream(JSON.parse(process.env.KUSTO_REPLAY_UPSTREAM));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["run", join(import.meta.dir, "bootstrap.ts"), ...(upstream ? ["--", upstream.command, ...upstream.args] : [])],
  cwd: upstream?.cwd ?? projectRoot,
  env: inheritedEnvironment(),
  stderr: "inherit",
});
try {
  const input: unknown = JSON.parse(await Bun.stdin.text());
  const request = CallToolRequestSchema.parse({ method: "tools/call", params: input });
  await client.connect(transport, { timeout: 120000 });
  const result = CallToolResultSchema.parse(await client.callTool(request.params, CallToolResultSchema, { timeout: 240000 }));
  process.stdout.write(JSON.stringify(process.argv[2] === "--notebook" ? renderResult(result) : result));
  if (isQueryError(result)) process.exitCode = 1;
} catch (error) {
  console.error("Notebook replay failed:", error);
  process.exitCode = 1;
} finally {
  await client.close();
  await transport.close();
}
