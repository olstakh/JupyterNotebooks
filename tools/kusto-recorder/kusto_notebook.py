"""Lightweight %%kusto cell magic that replays through the recording proxy."""

import json
import os
from pathlib import Path
import subprocess
import uuid


def register(ipython, project_root, connections, upstream=None):
    if ipython is None:
        raise RuntimeError("Use a Python/IPython notebook kernel to enable %%kusto.")
    root = Path(project_root)
    replay_run_id = "replay-" + uuid.uuid4().hex

    def execute(request):
        env = {**os.environ, "KUSTO_INVESTIGATION_ID": replay_run_id}
        env.pop("KUSTO_REPLAY_UPSTREAM", None)
        if upstream is not None:
            env["KUSTO_REPLAY_UPSTREAM"] = json.dumps(upstream)
        completed = subprocess.run(
            ["bun", "run", str(root / "tools" / "kusto-recorder" / "replay.ts"), "--notebook"],
            input=json.dumps(request),
            text=True,
            encoding="utf-8",
            capture_output=True,
            cwd=str(root),
            env=env,
            timeout=420,
        )
        if not completed.stdout.strip():
            raise RuntimeError(completed.stderr or "Replay helper returned no output.")
        try:
            output = json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise RuntimeError(
                f"Replay helper returned invalid JSON: {completed.stdout}\n{completed.stderr}"
            ) from error
        if output.get("output_type") == "error":
            raise RuntimeError(output["evalue"])
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr or completed.stdout)
        from IPython.display import display

        display(output["data"], raw=True)

    def kusto(line, cell):
        connection_name = line.strip() or next(iter(connections), None)
        if connection_name not in connections:
            raise ValueError(
                f"Unknown Kusto connection {connection_name!r}. "
                f"Available: {', '.join(connections) or '(none recorded)'}"
            )
        connection = connections[connection_name]
        if not cell.strip():
            raise ValueError("Enter a KQL query below %%kusto.")
        parameters = {**connection["parameters"], "query": cell}
        intent_lines = []
        for line_text in cell.splitlines():
            if not line_text.startswith("// Intent: "):
                break
            intent_lines.append(line_text[len("// Intent: "):])
        arguments = (
            {
                "intent": "\n".join(intent_lines) if intent_lines else "Replay notebook Kusto query",
                "command": "kusto_query",
                "parameters": parameters,
            }
            if connection["router"]
            else parameters
        )
        execute({"name": connection["tool"], "arguments": arguments})

    def mcp(line, cell):
        if line.strip():
            raise ValueError("Put the original MCP request JSON below %%mcp.")
        request = json.loads(cell)
        if not isinstance(request, dict) or not isinstance(request.get("name"), str):
            raise ValueError("An MCP request must be an object with a tool name.")
        execute(request)

    ipython.register_magic_function(kusto, magic_kind="cell", magic_name="kusto")
    ipython.register_magic_function(mcp, magic_kind="cell", magic_name="mcp")
    return replay_run_id
