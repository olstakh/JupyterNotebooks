import { $ } from "bun";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { inheritedEnvironment, projectRoot } from "./config.js";

const artifacts = join(projectRoot, "artifacts");
await mkdir(artifacts, { recursive: true });
const packed = await $`npm pack --json --pack-destination ${artifacts}`.cwd(projectRoot).quiet();
const [manifest] = JSON.parse(packed.text());
for (const file of manifest.files) {
  assert(!/(?:^|\/)(?:node_modules|\.investigations|fixtures|__pycache__)(?:\/|$)|\.test\.|\.mcp\.json|package-smoke/.test(file.path), `Unexpected packaged file: ${file.path}`);
}
const archive = join(artifacts, manifest.filename);
const root = await mkdtemp(join(tmpdir(), "kusto-package-consumer-"));
const env = inheritedEnvironment();
for (const key of ["KUSTO_RECORDING_DIR", "KUSTO_INVESTIGATION_ID", "KUSTO_RECORDER_ROOT", "KUSTO_REPLAY_UPSTREAM", "NODE_PATH"]) {
  delete env[key];
}
env.RECORDER_TEST_CUSTOM = "1";
env.RECORDER_TEST_SETTING = "installed package environment";
const request = { name: "run_team_query", arguments: { kql: "print Value = 7", target: "team database" } };

async function cli(args: string[], extraEnv: Record<string, string> = {}, input?: string): Promise<string> {
  const child = Bun.spawn([process.execPath, "x", "--no-install", "kusto-recorder", ...args], {
    cwd: root, env: { ...env, ...extraEnv },
    stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe",
  });
  if (input !== undefined && child.stdin) {
    child.stdin.write(input);
    child.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  assert.equal(exitCode, 0, stderr);
  return stdout.trim();
}

async function record(runId: string, extraEnv: Record<string, string> = {}) {
  const client = new Client({ name: "installed-package-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["x", "--no-install", "kusto-recorder", "--", process.execPath, "run", join(root, "team-server.ts"), "original argument"],
    cwd: root, env: { ...env, KUSTO_INVESTIGATION_ID: runId, ...extraEnv }, stderr: "inherit",
  });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools[0].name, "run_team_query");
    const response = CallToolResultSchema.parse(await client.callTool(request));
    assert.deepEqual(response.content, [{ type: "text", text: JSON.stringify({ received: request.arguments }) }]);
    assert.equal(response.structuredContent?.cwd, root);
  } finally {
    await client.close();
    await transport.close();
  }
}

try {
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "recorder-package-consumer", private: true, type: "module" }));
  await $`npm install --ignore-scripts --no-audit --no-fund --save-dev ${archive}`.cwd(root).quiet();
  await copyFile(join(import.meta.dir, "fixtures", "upstream.ts"), join(root, "team-server.ts"));
  const installed = join(root, "node_modules", manifest.name);
  assert.equal(await cli(["--version"]), manifest.version);
  assert.equal(await cli(["helper-path"]), join(installed, "tools", "kusto-recorder", "kusto_notebook.py"));
  await record("package-default");
  const notebookPath = join(root, ".investigations", "package-default", "investigation.ipynb");
  const notebook = JSON.parse(await readFile(notebookPath, "utf8"));
  assert.deepEqual(notebook.metadata.kusto_recorder.entries[0].request, request);
  const snapshot = await cli(["evidence", "--run", "package-default"]);
  const exported = JSON.parse(await readFile(snapshot, "utf8"));
  assert.deepEqual(exported.metadata.kusto_recorder.upstream, notebook.metadata.kusto_recorder.upstream);
  assert.equal(snapshot.startsWith(join(root, ".investigations")), true);
  await record("package-relative", { KUSTO_RECORDING_DIR: "custom-evidence" });
  const customSnapshot = await cli(["evidence", "--run", "package-relative"], { KUSTO_RECORDING_DIR: "custom-evidence" });
  assert.equal(customSnapshot.startsWith(join(root, "custom-evidence")), true);
  const replayed = JSON.parse(await cli(["replay", "--notebook"], {
    KUSTO_INVESTIGATION_ID: "package-replay",
    KUSTO_REPLAY_UPSTREAM: JSON.stringify(notebook.metadata.kusto_recorder.upstream),
  }, JSON.stringify(request)));
  assert.equal(replayed.output_type, "display_data");
  assert.equal(replayed.data["text/plain"].includes("print Value = 7"), true);
  const replayNotebook = JSON.parse(await readFile(join(root, ".investigations", "package-replay", "investigation.ipynb"), "utf8"));
  assert.deepEqual(replayNotebook.metadata.kusto_recorder.entries[0].request, request);

  if (process.env.KUSTO_PACKAGE_TEST_PYTHON) {
    const originalSetup = exported.cells[1].source;
    exported.cells[1].source = originalSetup.replace(JSON.stringify(installed), JSON.stringify(join(root, "recorded-on-another-machine")));
    assert.notEqual(exported.cells[1].source, originalSetup, "Exercise installed-helper discovery rather than the embedded installation path.");
    await writeFile(snapshot, JSON.stringify(exported));
    const python = Bun.spawn([process.env.KUSTO_PACKAGE_TEST_PYTHON, "-c", `
import sys
import nbformat
from IPython.core.interactiveshell import InteractiveShell
notebook = nbformat.read(sys.argv[1], as_version=4)
nbformat.validate(notebook)
shell = InteractiveShell.instance()
shell.run_cell(notebook.cells[1].source).raise_error()
shell.run_cell(notebook.cells[2].source).raise_error()
`, snapshot], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(python.stdout).text(), new Response(python.stderr).text(), python.exited,
    ]);
    assert.equal(exitCode, 0, `${stdout}\n${stderr}`);
    assert.equal(stdout.includes("print Value = 7"), true);
  } else {
    console.log("Python replay not exercised; set KUSTO_PACKAGE_TEST_PYTHON to an interpreter with IPython and nbformat.");
  }
  console.log(`Installed-package recording, export, directory overrides, and replay succeeded.\n${archive}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
