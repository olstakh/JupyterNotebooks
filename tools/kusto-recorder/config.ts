import { resolve } from "node:path";
import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";

export const projectRoot = resolve(import.meta.dir, "..", "..");
export const azureMcpVersion = "3.0.0";

export type ReplayUpstream = {
  command: string;
  args: string[];
  cwd: string;
};

export function parseReplayUpstream(value: unknown): ReplayUpstream {
  if (typeof value !== "object" || value === null
    || !("command" in value) || typeof value.command !== "string" || !value.command.trim()
    || !("args" in value) || !Array.isArray(value.args) || !value.args.every((arg): arg is string => typeof arg === "string")
    || !("cwd" in value) || typeof value.cwd !== "string" || !value.cwd.trim()) {
    throw new Error("Invalid upstream launch settings: expected command, args, and cwd.");
  }
  return { command: value.command, args: value.args, cwd: value.cwd };
}

export function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export function upstreamConfig(args = process.argv.slice(2)): StdioServerParameters {
  if (args.length) {
    const original = args[0] === "--" ? args.slice(1) : args;
    if (!original[0]?.trim() || original[0].startsWith("-")) {
      throw new Error("Usage: bootstrap.ts -- <original MCP command> [original arguments...]");
    }
    return {
      command: original[0],
      args: original.slice(1),
      cwd: process.cwd(),
      env: inheritedEnvironment(),
      stderr: "inherit",
    };
  }
  return {
    command: process.execPath,
    args: ["x", `@azure/mcp@${azureMcpVersion}`, "server", "start", "--namespace", "kusto", "--read-only"],
    cwd: projectRoot,
    env: inheritedEnvironment(),
    stderr: "inherit",
  };
}
