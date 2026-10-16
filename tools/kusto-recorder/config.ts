import { resolve } from "node:path";
import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";

export const projectRoot = resolve(import.meta.dir, "..", "..");
export const azureMcpVersion = "3.0.0";

export function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export function upstreamConfig(): StdioServerParameters {
  return {
    command: process.execPath,
    args: ["x", `@azure/mcp@${azureMcpVersion}`, "server", "start", "--namespace", "kusto", "--read-only"],
    cwd: projectRoot,
    env: inheritedEnvironment(),
    stderr: "inherit",
  };
}
