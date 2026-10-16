# Kusto investigation recorder

A local MCP proxy that runs the Azure MCP server, records every forwarded tool
call, and generates a Jupyter evidence notebook automatically. No Jupyter server
or Kqlmagic is needed to record or export.

## Start

Prerequisites: Bun, an agent with local stdio MCP support, and existing Azure/Kusto
authentication and read permissions. The MCP launcher automatically installs
locked project dependencies when the SDK is absent. The upstream Azure MCP
package is downloaded on first use; it is pinned in
`tools\kusto-recorder\config.ts`. Installation requires registry access and writes
dependencies to the project directory. You can also install explicitly:

```powershell
bun install --frozen-lockfile
```

Open your agent in this folder and load `.mcp.json`. In Copilot CLI, inspect the
connection with `/mcp`; restart the session if needed to replace the old direct
Azure MCP connection. The connection should expose `record_investigation_note`
and `get_investigation_notebook` in addition to the upstream Kusto tools.

Ask for an investigation normally. No prompt changes, note calls, or
end-of-investigation export calls are needed. Request/response capture and notebook
generation are enforced by the proxy, not by agent instructions.

Example prompt:

> Check a bounded sample of recent Kusto failures.

Use the cluster/database appropriate to your team; the optional demo below uses
the previously verified Power Apps runtime database.

## Get evidence at any time

From a separate terminal in this folder:

```powershell
bun run evidence
```

This creates a notebook snapshot and prints its absolute path. It reads the
durable local records: **no agent, Azure connection, credentials, or query replay
is involved**. It works during an investigation and after the agent has stopped.
In Copilot CLI, `!bun run evidence` runs it as a shell command rather than asking
the model to export.

With one active recorder process, the command selects that run. With no active
process, it selects the saved run with the most recent recorded tool activity
(unused startup runs do not hide existing evidence). With
multiple active processes, it refuses to guess; list runs and choose explicitly:

```powershell
bun run evidence --list
bun run evidence --run <run-id>
```

`KUSTO_INVESTIGATION_ID`, if set in the export terminal, also selects an explicit
run. Session tracking identifies local recorder processes, not Copilot chat IDs.
An MCP restart starts a new run unless an explicit ID is configured.

Each export creates a separate `snapshot-*.ipynb`, leaving the continuously
updated notebook and earlier snapshots untouched. Calls still running at the
snapshot boundary remain visibly unfinished. Snapshots do not change which saved
run is considered most recent.

**What is automatic:** tool calls in sequence, KQL, target, parameters, any
existing `intent` argument, results, errors, and timestamps. **What is not:**
the agent's conversation or explanations that never pass through the MCP proxy.
The optional annotation tool remains available, but evidence export never
requires it or invents missing explanations.

## Output

Each MCP server process starts a new run under:

```text
.investigations\<run-id>\
    E-<uuid>.started.json    Request persisted before execution
    E-<uuid>.json            Original response or transport error
    N-<uuid>.json            Optional agent-authored note
    session.json            Recorder process lifecycle (new runs)
    investigation.ipynb     Regenerated view of these records
    snapshot-*.ipynb        User-requested point-in-time exports
```

The notebook includes readable KQL, exact MCP arguments, original response
outputs, timing/status, existing tool-call intent, and any optional notes. Calls without a completed
record remain visibly unfinished. Discovery through the Kusto router is also
recorded; MCP `tools/list` itself is not an evidence query.

Query intent must be saved before forwarding, and a result must be saved before
it is returned. Failed persistence withholds the result and reports an error.
Notebook export failures are logged to stderr; records remain available, and
`get_investigation_notebook` retries export explicitly.

To rebuild a notebook offline without connecting to Azure:

```powershell
bun run export:notebook <run-id>
```

Only responses actually returned by the upstream MCP server can be captured.
Truncated, summarized, or partial upstream results cannot be reconstructed.
Transport success is not a guarantee that the response payload has no query error.
There is no automatic query retry.

## Replay

Open the notebook in VS Code or Jupyter using a Python/IPython kernel. Preserve a
copy of the original before re-running cells. The setup cell and query cells use
Python's standard library and IPython; they call the same recording proxy through
a Bun replay helper, not directly through Kusto credentials.

Run the setup cell first. If the project cannot be found, set `recorder_root` in
that cell or set `KUSTO_RECORDER_ROOT` to the project directory. Each setup execution
allocates a new replay run ID, shared by subsequent query cells. Relative KQL time
expressions are re-evaluated; this is live replay, not historical reconstruction.
Discovery/schema cells retain original outputs but are not automatically replayed.

## Configuration

Optional MCP `env` values:

- `KUSTO_RECORDING_DIR`: output directory, relative to the project or absolute.
- `KUSTO_INVESTIGATION_ID`: explicit run ID (letters, digits, `_`, `-`; up to 100
  characters). Defaults to a timestamp plus random suffix. Use a separate ID for
  each investigation. Do not share one ID across concurrent MCP server processes.

Credentials are inherited by the local upstream process, not written by this
project into configuration or notebook setup cells. Queries and tool responses
are saved verbatim and may themselves contain secrets or sensitive telemetry.
The output directory is gitignored, **not encrypted or redacted**. Review it
before sharing and use appropriate access controls and retention.

The proxy only guarantees capture for calls routed through it. Removing the old
MCP registration does not prevent an agent with other credentials/network access
from bypassing it. Strong enforcement requires credential/network isolation.

## Demo and development

```powershell
bun run demo
bun run check
bun test
```

The demo makes two bounded live aggregate queries through the actual proxy and
writes illustrative, scripted commentary. It is a wiring demonstration, not an
autonomous incident diagnosis. It prints the resulting notebook path.

Share the project files, lockfile, `.mcp.json`, and `AGENTS.md` with teammates.
The launcher installs dependencies on first use; teammates provide their own approved Azure authentication.
Do not distribute `.investigations` or `node_modules` by default.
