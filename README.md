# Kusto investigation recorder

A local stdio MCP tool proxy that runs your existing Kusto MCP server and durably records every
forwarded tool call in a Jupyter notebook. No Jupyter server
or Kqlmagic is needed to record or export.

## Install the local package in another repository

Prerequisite: Bun 1.3.13 or later. No source checkout is needed by consumers.
Copy the `.tgz` to an approved team location, then run this from the consuming
repository (replace the archive path with its actual location):

```powershell
npm install --save-dev 'C:\packages\kusto-investigation-recorder-0.1.0.tgz'
bun x --no-install kusto-recorder --help
```

The package includes the recorder runtime and Python notebook helper. Python with
IPython/Jupyter is needed only to replay notebooks, not to record investigations.
The dependency manifest and lockfile will reference the local archive, so keep
that archive at a team-accessible location or have each teammate install their
own copy. This is a trial distribution format, not a published registry package.

In `.mcp.json`, change **only the selected Kusto server's launch configuration**.
For example:

```json
{
  "mcpServers": {
    "team-kusto": {
      "type": "stdio",
      "command": "bun",
      "args": [
        "x", "--no-install", "kusto-recorder", "--",
        "npx", "--yes", "@team/kusto-mcp", "--region", "eastus2"
      ]
    }
  }
}
```

Replace everything after `--` with the team's actual original command and
arguments. Keep its existing `env`, working-directory, and approval settings.
The team package in this example is illustrative, not an included dependency.
Other MCP server entries remain unchanged. Reload the selected server afterward.

By default evidence goes to **`<current working directory>\.investigations`**,
normally the repository from which the agent runs. No `env` setting is required.
To override it, add `"KUSTO_RECORDING_DIR": "other-evidence"` to that server's
`env`, or use an absolute path. Relative overrides also resolve from the current
working directory, never from the installed package directory.

From the same repository, get evidence without asking the agent:

```powershell
bun x --no-install kusto-recorder evidence
bun x --no-install kusto-recorder evidence --list
bun x --no-install kusto-recorder evidence --run <run-id>
```

If the MCP registration overrides `KUSTO_RECORDING_DIR`, set the same value in the
export terminal; the terminal does not inherit the MCP entry's environment.
`--no-install` prevents the command from fetching an unrelated registry package
when this local installation is missing.

## Start

Prerequisites: Bun, an agent with local stdio MCP support, and existing Azure/Kusto
authentication and read permissions. The MCP launcher automatically installs
locked project dependencies when the SDK is absent. With the built-in default,
the upstream Azure MCP package is downloaded on first use; it is pinned in
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
generation are enforced by the proxy, not by agent instructions. Upstream tool
definitions, arguments, and returned tool results are preserved; no evidence
footer is added to the server's responses. Upstream initialization instructions
are retained alongside the recorder's instructions.

## Wrap an existing team's server

For a source-checkout trial, keep the same server name, environment, working directory, and original launch
arguments. Change its command to Bun and prefix its original command/arguments
with `run <absolute path to bootstrap.ts> --`.

For example, an existing server:

```json
{
  "mcpServers": {
    "team-kusto": {
      "type": "stdio",
      "command": "npx",
      "args": ["--yes", "@team/kusto-mcp", "--region", "eastus2"],
      "env": { "TEAM_ENVIRONMENT": "production" }
    }
  }
}
```

Becomes:

```json
{
  "mcpServers": {
    "team-kusto": {
      "type": "stdio",
      "command": "bun",
      "args": [
        "run", "C:\\code\\JupyterNotebooks\\tools\\kusto-recorder\\bootstrap.ts",
        "--", "npx", "--yes", "@team/kusto-mcp", "--region", "eastus2"
      ],
      "env": { "TEAM_ENVIRONMENT": "production" }
    }
  }
}
```

The team package above is illustrative: keep your actual command and arguments,
including its version, authentication options, and read-only restrictions. Do
not leave a second unwrapped registration active. Preserve any client-supported
`cwd`, approval, or other per-server settings; the child runs in the working
directory the MCP client gives the wrapper, with the wrapper's environment.
Evidence defaults to `.investigations` under that working directory.
`KUSTO_RECORDING_DIR` can override it with a relative or absolute path.

This mode does not select Azure MCP, pin the team's package, change query
arguments, or add flags. Running the wrapper with no arguments retains the
original pinned Azure MCP default for backward compatibility. An invalid
command-prefix invocation fails instead of falling back to Azure.

This currently supports **local stdio tool servers**. Remote HTTP/SSE servers and
non-tool MCP features such as resources, prompts, sampling, and elicitation are
not proxied. It is not yet a transparent proxy for every MCP capability.

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
live evidence notebook: **no agent, Azure connection, credentials, or query replay
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
    investigation.ipynb     Source of truth: pending queries and final outcomes
    session.json            Small process-lifecycle manifest, not query evidence
    .writer.lock            Exists while this run is owned by a recorder
    snapshot-*.ipynb        User-requested point-in-time exports
```

The notebook shows a short introduction, one collapsed setup cell, and **KQL
cells with intent comments and results directly underneath**. Technical details
(original MCP requests/responses, timing, evidence IDs, discovery calls, and
optional notes) are preserved in `metadata.kusto_recorder.entries`. Cells reference
evidence IDs rather than duplicating raw responses. There are no per-call JSON
files by default. A notebook is self-contained as an evidence artifact; replay
still needs the recorder project and approved authentication.
Other tool schemas appear as editable `%%mcp` JSON request cells with their saved
results, rather than being silently omitted or guessed into an Azure query.

New recordings use evidence format **3**. Each execution includes an `adapter`
identifier and JSON request/response evidence; replay configurations are stored
per adapter in `metadata.kusto_recorder.adapter_configurations`. The current MCP
adapter also preserves the existing upstream metadata fields. Version-2 notebooks
and older JSON/cell recordings remain readable: their executions are identified
as MCP, and the old `tool_error` status maps to the transport-neutral `failed`
status. Snapshot export leaves the old source intact; initializing a writer
updates its source to the current format.

The recorder atomically saves a pending entry **before forwarding** a call, then
updates the same entry with the response or error **before returning** results.
Failed pending persistence prevents execution; failed result persistence withholds
results. Interrupted calls remain pending/uncertain, without automatic retry.
Writes are serialized and temporary files are flushed before atomic replacement.

To create a snapshot offline without connecting to Azure (an alias for explicit
run export):

```powershell
bun run export:notebook <run-id>
```

Existing per-call JSON recordings and older notebook metadata remain readable.
New snapshots include complete evidence in notebook metadata. Existing JSON files
are not deleted automatically, and a corrupt authoritative notebook never silently
falls back to possibly stale debug copies.

### Tradeoffs and recovery

Each pending/result update rewrites the notebook, so large result sets and long
investigations increase write time and disk usage. Keep queries bounded. This
format is intended for one writer and modest investigation volumes, not a
high-throughput event store.

**Open/edit snapshots, not the live `investigation.ipynb` while recording.**
Jupyter autosave could overwrite newer evidence with an older copy. The recorder
detects external changes and stops rather than overwriting them. Keep backups:
the notebook is now the primary evidence record, and deleting it normally cannot
be repaired from per-call files.

A second recorder cannot own the same run concurrently. Graceful shutdown removes
`.writer.lock`. After a forced termination, evidence is still readable/exportable;
start a new run, or remove a leftover lock only after verifying its recorded PID
has exited. A process interruption preserves the last fully written notebook;
this is not a substitute for storage backups or protection against disk failure.

### Optional per-call debug JSON

Set `"KUSTO_DEBUG_JSON": "1"` in the MCP server's `env` to additionally write:

```text
debug\E-<uuid>.started.json
debug\E-<uuid>.json
debug\N-<uuid>.json
```

These are diagnostic copies; the notebook remains authoritative. Debug-write
failures are reported on stderr but do not discard successfully persisted
notebook evidence. Existing `.started.json` copies are intentionally retained in
debug mode to inspect the pre-execution state.

Only responses actually returned by the upstream MCP server can be captured.
Truncated, summarized, or partial upstream results cannot be reconstructed.
Transport success is not a guarantee that the response payload has no query error.
There is no automatic query retry.

## Replay

**Kqlmagic is not required.** Use a Python/IPython kernel in VS Code or Jupyter.
Run the collapsed setup cell once (or use Run All); it registers the project's
lightweight `%%kusto` cell magic. Then edit or run a query cell normally:

```text
%%kusto
// Intent: Inspect a bounded sample of recent telemetry.
event
| where ['time'] > ago(1h)
| take 10
```

The magic sends the cell's KQL through the same recording proxy and displays only
the results, not SDK/MCP plumbing. Only Bun and the project's files are needed
beyond the Python/IPython kernel; there is no Kusto Python SDK or Kqlmagic
installation. Do not use an ordinary Python cell without the `%%kusto` header:
KQL is not Python.

Existing tool-call intent is added automatically as `// Intent:` comments. Every
intent line is commented; the original request remains unchanged in metadata.
Replay retains those comments and their intent rather than accumulating duplicate
headers. If the original call has no intent, no explanation is invented.

The first recorded target is the default connection. If an investigation queried
other targets, those cells use `%%kusto connection2` (and so on); the setup cell
contains the connection definitions. Sample-table calls become equivalent
`table("name") | take N` query cells, with original requests preserved in metadata.

For command-prefix recordings, replay starts the recorded original command with
its original arguments and working directory, not the default Azure server.
The launch settings are retained in notebook metadata and the collapsed setup
cell. Environment variables are **not** saved: start Jupyter with the team's
required environment/authentication available. Keep secrets in environment
variables rather than launch arguments, since recorded command arguments are
part of the evidence. Review launch settings before running a shared notebook.
Moving to another machine can require updating executable paths and working
directory in the setup cell. Offline exports preserve the original upstream.

Preserve a copy before re-running cells. Each setup execution creates a new replay
run ID, shared by subsequent queries. Relative time expressions are re-evaluated:
this is live replay, not historical reconstruction. On another machine, install
the recorder package in the notebook's repository; setup can discover the installed
helper without the author's checkout. `KUSTO_RECORDER_ROOT` can explicitly select
an installed package directory or source checkout. No environment credentials are
embedded in the setup cell.

## Configuration

Optional MCP `env` values:

- `KUSTO_RECORDING_DIR`: output directory, relative to the process working
  directory or absolute. Defaults to `.investigations` under that working directory.
- `KUSTO_INVESTIGATION_ID`: explicit run ID (letters, digits, `_`, `-`; up to 100
  characters). Defaults to a timestamp plus random suffix. Use a separate ID for
  each investigation. Concurrent writers using the same ID are rejected.
- `KUSTO_DEBUG_JSON`: `1` to keep per-call debug JSON, `0` or unset for
  notebook-only query evidence.

Environment variables, including credentials, are inherited by the local upstream
process and are not written into notebook setup cells. Launch commands and
arguments are recorded; do not pass secrets as command-line arguments. Queries and tool responses
are saved verbatim and may themselves contain secrets or sensitive telemetry.
The output directory is gitignored, **not encrypted or redacted**. Review it
before sharing and use appropriate access controls and retention.

The proxy only guarantees capture for calls routed through it. Removing the old
MCP registration does not prevent an agent with other credentials/network access
from bypassing it. Strong enforcement requires credential/network isolation.

## Demo and development

### Adapter boundaries

Only the MCP adapter is implemented today. REST/CLI execution and alternative
storage backends are not included in this refactor.

- `model.ts` defines JSON evidence, execution statuses, `ExecutionAdapter`, and
  `NotebookAdapter`, without importing the MCP SDK.
- `recorder.ts` owns pending/completion persistence, failures, serialized writes,
  and source-integrity checks. `execute(adapter, request, invoke)` returns the
  original typed result after saving the adapter's JSON evidence.
- `notebook.ts` builds cells from adapter-provided query/result presentations.
  Unsupported adapter evidence stays readable, and its replay cell fails
  explicitly rather than treating it as an MCP call.
- `adapters\mcp.ts` owns MCP schemas, Azure query recognition, error detection,
  result rendering, launch defaults, and notebook setup.
- `adapters\mcp-replay.ts` and `proxy.ts` own the existing MCP execution paths.
  `application.ts` registers the installed adapter for recording and offline export.

A future adapter supplies request/result capture and error classification through
`ExecutionAdapter`. Its `NotebookAdapter` supplies stored-evidence validation,
query/result presentation, and setup/configuration handling. Register it at the
application boundary and wire its execution/replay entry point; no MCP-shaped
request or response is required by the shared recorder.

Adapters must exclude authentication secrets from captured evidence and preserve
the native client's behavior. The recorder does not acquire credentials or retry
queries. Whole-notebook persistence and the single-writer limitation are unchanged.

```powershell
bun run demo
bun run check
bun test
```

Optional Python tests (requires IPython and nbformat, not Kqlmagic):

```powershell
python tools\kusto-recorder\test_notebook.py
```

The demo makes two bounded live aggregate queries through the actual proxy and
writes illustrative, scripted commentary. It is a wiring demonstration, not an
autonomous incident diagnosis. It prints the resulting notebook path.

### Build and exercise the local archive

From the source repository:

```powershell
New-Item -ItemType Directory -Force artifacts | Out-Null
npm pack --pack-destination artifacts
```

This creates `artifacts\kusto-investigation-recorder-0.1.0.tgz`. The package
allowlist includes only runtime files, the notebook helper, and documentation;
investigation evidence, MCP configuration, dependencies, and tests are excluded.
The package remains private to guard against accidental registry publication;
`npm pack` and local archive installation still work. Nothing is published.

The isolated installation smoke check also builds the archive, installs it in a
temporary consuming repository, and exercises MCP recording, export, directory
overrides, and replay:

```powershell
bun run test:package
```

Set `KUSTO_PACKAGE_TEST_PYTHON` to a Python interpreter with IPython and nbformat
to additionally run an exported notebook using installed-helper discovery.
The temporary consumer is removed afterward; the archive remains in `artifacts`.
Dependency installation requires registry/cache access. Teammates still provide
their own approved Kusto MCP server and authentication.
