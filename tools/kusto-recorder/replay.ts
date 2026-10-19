import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolRequestSchema, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { join } from "node:path";
import { inheritedEnvironment, parseReplayUpstream, projectRoot } from "./config.js";
import { isQueryError, renderResult } from "./notebook.js";

export async function replay(args = process.argv.slice(2)): Promise<void> {
  const client = new Client({ name: "kusto-notebook-replay", version: "0.1.0" });
  let transport: StdioClientTransport | undefined;
  try {
    if (args.length && !(args.length === 1 && args[0] === "--notebook")) {
      throw new Error("Usage: kusto-recorder replay [--notebook]");
    }
    const upstream = process.env.KUSTO_REPLAY_UPSTREAM === undefined ? undefined
      : parseReplayUpstream(JSON.parse(process.env.KUSTO_REPLAY_UPSTREAM));
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", join(projectRoot, "bin", "kusto-recorder.js"), ...(upstream ? ["--", upstream.command, ...upstream.args] : [])],
      cwd: upstream?.cwd ?? process.cwd(),
      env: inheritedEnvironment(),
      stderr: "inherit",
    });
    const input: unknown = JSON.parse(await Bun.stdin.text());
    const request = CallToolRequestSchema.parse({ method: "tools/call", params: input });
    await client.connect(transport, { timeout: 120000 });
    const result = CallToolResultSchema.parse(await client.callTool(request.params, CallToolResultSchema, { timeout: 240000 }));
    process.stdout.write(JSON.stringify(args[0] === "--notebook" ? renderResult(result) : result));
    if (isQueryError(result)) process.exitCode = 1;
  } catch (error) {
    console.error("Notebook replay failed:", error);
    process.exitCode = 1;
  } finally {
    await client.close();
    await transport?.close();
  }
}

if (import.meta.main) await replay();
