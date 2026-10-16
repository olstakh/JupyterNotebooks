"""Run with Python, IPython and nbformat; no Kqlmagic is needed."""

import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from IPython.core.interactiveshell import InteractiveShell
import nbformat

import kusto_notebook


ROOT = Path(__file__).resolve().parents[2]
CONNECTIONS = {
    "connection1": {
        "tool": "kusto",
        "router": True,
        "parameters": {"cluster-uri": "https://example.kusto.windows.net", "database": "logs"},
    },
    "connection2": {
        "tool": "kusto_query",
        "router": False,
        "parameters": {"cluster-uri": "https://other.kusto.windows.net", "database": "other"},
    },
}
OUTPUT = {
    "output_type": "display_data",
    "data": {"text/plain": "Value\n7", "text/html": "<table><tr><td>7</td></tr></table>"},
    "metadata": {},
}


class NotebookTests(unittest.TestCase):
    def setUp(self):
        self.shell = InteractiveShell.instance()
        self.run_id = kusto_notebook.register(self.shell, ROOT, CONNECTIONS)

    @patch("IPython.display.display")
    @patch("subprocess.run")
    def test_magic_submits_editable_kql_and_displays_only_result(self, run, display):
        run.return_value = subprocess.CompletedProcess([], 0, json.dumps(OUTPUT), "")
        self.shell.run_cell_magic("kusto", "", "print Value = 7")
        request = json.loads(run.call_args.kwargs["input"])
        self.assertEqual(request["arguments"]["parameters"]["query"], "print Value = 7")
        self.assertEqual(request["arguments"]["parameters"]["database"], "logs")
        self.assertEqual(run.call_args.kwargs["env"]["KUSTO_INVESTIGATION_ID"], self.run_id)
        self.assertEqual(run.call_args.args[0][-1], "--notebook")
        display.assert_called_once_with(OUTPUT["data"], raw=True)

    @patch("IPython.display.display")
    @patch("subprocess.run")
    def test_connection_selection_preserves_target(self, run, display):
        run.return_value = subprocess.CompletedProcess([], 0, json.dumps(OUTPUT), "")
        self.shell.run_cell_magic("kusto", "connection2", "print 1")
        request = json.loads(run.call_args.kwargs["input"])
        self.assertEqual(request["name"], "kusto_query")
        self.assertEqual(request["arguments"]["database"], "other")
        self.assertNotIn("parameters", request["arguments"])

    @patch("subprocess.run")
    def test_invalid_connection_and_empty_query_do_not_execute(self, run):
        with self.assertRaisesRegex(ValueError, "Unknown Kusto connection"):
            self.shell.run_cell_magic("kusto", "missing", "print 1")
        with self.assertRaisesRegex(ValueError, "Enter a KQL query"):
            self.shell.run_cell_magic("kusto", "", " ")
        run.assert_not_called()

    @patch("IPython.display.display")
    @patch("subprocess.run")
    def test_errors_are_not_displayed_as_success(self, run, display):
        run.return_value = subprocess.CompletedProcess(
            [], 1, json.dumps({"output_type": "error", "evalue": "Permission denied"}), ""
        )
        with self.assertRaisesRegex(RuntimeError, "Permission denied"):
            self.shell.run_cell_magic("kusto", "", "print 1")
        display.assert_not_called()

    def test_generated_notebook_validates_and_runs_as_real_ipython_cells(self):
        entry = {
            "type": "execution",
            "id": "E-abcd",
            "startedAt": "2026-01-01T00:00:00Z",
            "status": "succeeded",
            "request": {
                "name": "kusto",
                "arguments": {
                    "command": "kusto_query",
                    "parameters": {**CONNECTIONS["connection1"]["parameters"], "query": "print Value = 7"},
                },
            },
            "result": {"content": [{"type": "text", "text": '{"status":200,"results":{"items":[{"Value":"long"},[7]]}}'}]},
        }
        module_path = str(ROOT / "tools" / "kusto-recorder" / "notebook.ts")
        script = (
            f"import {{makeNotebook}} from {json.dumps(module_path)};"
            f"console.log(JSON.stringify(makeNotebook('kernel-test', [{json.dumps(entry)}])));"
        )
        completed = subprocess.run(
            ["bun", "--eval", script], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", check=True
        )
        notebook = nbformat.reads(completed.stdout, as_version=4)
        nbformat.validate(notebook)
        self.assertEqual(len(notebook.cells), 3)
        setup, query = notebook.cells[1:]
        self.assertTrue(setup.metadata.jupyter.source_hidden)
        self.assertEqual(query.source, "%%kusto\nprint Value = 7")
        result = self.shell.run_cell(setup.source)
        result.raise_error()
        with patch("subprocess.run") as run, patch("IPython.display.display") as display:
            run.return_value = subprocess.CompletedProcess([], 0, json.dumps(OUTPUT), "")
            self.shell.run_cell(query.source).raise_error()
            self.assertEqual(json.loads(run.call_args.kwargs["input"])["arguments"]["parameters"]["query"].strip(), "print Value = 7")
            display.assert_called_once_with(OUTPUT["data"], raw=True)


if __name__ == "__main__":
    unittest.main()
