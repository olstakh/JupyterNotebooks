#!/usr/bin/env bun
import { resolve } from "node:path";

const [command, ...args] = process.argv.slice(2);
if (command === "--help" || command === "-h") {
  console.log(`Usage:
  kusto-recorder -- <original MCP command> [original arguments...]
  kusto-recorder evidence [--list | --run <run-id>]
  kusto-recorder helper-path
  kusto-recorder --version

Without an upstream command, the pinned Azure Kusto MCP server is used.
Evidence defaults to .investigations under the current working directory.
Override it with KUSTO_RECORDING_DIR. Bun is required.`);
} else if (command === "--version") {
  console.log((await Bun.file(new URL("../package.json", import.meta.url)).json()).version);
} else if (command === "helper-path") {
  if (args.length) throw new Error("Usage: kusto-recorder helper-path");
  console.log(resolve(import.meta.dir, "..", "tools", "kusto-recorder", "kusto_notebook.py"));
} else if (command === "evidence") {
  const { evidence } = await import("../tools/kusto-recorder/evidence.ts");
  await evidence(args);
} else if (command === "replay") {
  const { replay } = await import("../tools/kusto-recorder/replay.ts");
  await replay(args);
} else {
  await import("../tools/kusto-recorder/index.ts");
}
