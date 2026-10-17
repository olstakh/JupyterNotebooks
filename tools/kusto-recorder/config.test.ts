import { expect, test } from "bun:test";
import { azureMcpVersion, inheritedEnvironment, parseReplayUpstream, projectRoot, upstreamConfig } from "./config.js";

test("keeps the original Azure launch as the no-argument default", () => {
  const config = upstreamConfig([]);
  expect(config.command).toBe(process.execPath);
  expect(config.args).toEqual(["x", `@azure/mcp@${azureMcpVersion}`, "server", "start", "--namespace", "kusto", "--read-only"]);
  expect(config.cwd).toBe(projectRoot);
});

test("command prefix preserves the original command, arguments, cwd, and environment", () => {
  const args = ["--", "team-mcp", "--query-option", "two words", "--", "literal"];
  const config = upstreamConfig(args);
  expect(config.command).toBe("team-mcp");
  expect(config.args).toEqual(args.slice(2));
  expect(config.cwd).toBe(process.cwd());
  expect(config.env).toEqual(inheritedEnvironment());
  expect(upstreamConfig(args.slice(1))).toEqual(config);
});

test("rejects incomplete and ambiguous launch configuration instead of using Azure", () => {
  for (const args of [["--"], ["--", ""], ["--", " "], ["--url", "https://example.test"]]) {
    expect(() => upstreamConfig(args)).toThrow("Usage:");
  }
  expect(() => parseReplayUpstream({ command: "team-mcp", args: "not an array", cwd: "somewhere" })).toThrow("Invalid upstream");
});
