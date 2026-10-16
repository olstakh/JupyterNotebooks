"""Lightweight %%kusto cell magic that replays through the recording proxy."""

import json
import os
from pathlib import Path
import subprocess
import uuid


def register(ipython, project_root, connections):
    if ipython is None:
        raise RuntimeError("Use a Python/IPython notebook kernel to enable %%kusto.")
    root = Path(project_root)
    replay_run_id = "replay-" + uuid.uuid4().hex

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
        arguments = (
            {
                "intent": "Replay notebook Kusto query",
                "command": "kusto_query",
                "parameters": parameters,
            }
            if connection["router"]
            else parameters
        )
        completed = subprocess.run(
            ["bun", "run", str(root / "tools" / "kusto-recorder" / "replay.ts"), "--notebook"],
            input=json.dumps({"name": connection["tool"], "arguments": arguments}),
            text=True,
            encoding="utf-8",
            capture_output=True,
            cwd=str(root),
            env={**os.environ, "KUSTO_INVESTIGATION_ID": replay_run_id},
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

    ipython.register_magic_function(kusto, magic_kind="cell", magic_name="kusto")
    return replay_run_id
