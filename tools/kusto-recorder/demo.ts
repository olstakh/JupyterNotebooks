import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { join } from "node:path";
import { inheritedEnvironment, projectRoot } from "./config.js";

const runId = `demo-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const client = new Client({ name: "kusto-recorder-demo", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["run", join(import.meta.dir, "bootstrap.ts")],
  cwd: projectRoot,
  env: { ...inheritedEnvironment(), KUSTO_INVESTIGATION_ID: runId },
  stderr: "inherit",
});

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: 240000 }));
  if (result.isError) throw new Error(JSON.stringify(result));
  return result;
}

function evidenceId(result: CallToolResult): string {
  for (const block of result.content) {
    if (block.type === "text") {
      const match = /Recorder evidence ID: (E-[\da-f-]+)/.exec(block.text);
      if (match) return match[1];
    }
  }
  throw new Error("Query response has no evidence ID.");
}

try {
  await client.connect(transport, { timeout: 120000 });
  const tools = await client.listTools({}, { timeout: 120000 });
  const router = tools.tools.find((tool) => tool.name === "kusto");
  if (!router) throw new Error(`Expected Kusto router; discovered: ${tools.tools.map((tool) => tool.name).join(", ")}`);
  await call("record_investigation_note", {
    kind: "plan",
    text: "Permission-check demonstration, not a livesite diagnosis. Check a bounded sample of error/failure telemetry from the last hour, then group a bounded sample by event classification. Return only aggregates, not raw incident details.",
  });
  const common = {
    "cluster-uri": "https://powerappsclient.eastus2.kusto.windows.net",
    database: "PowerApps-1DS",
  };
  const first = await call(router.name, {
    intent: "Check access to a bounded sample of recent production errors",
    command: "kusto_query",
    parameters: {
      ...common,
      query: "event\n| where ['time'] > ago(1h)\n| where data_event_Name == \"PowerAppsClient.Error\" or data_scenarioResult == \"Failed\"\n| take 10\n| summarize MatchingRowsInSample = count()",
    },
  });
  console.log("First query response:", JSON.stringify(first));
  const firstId = evidenceId(first);
  await call("record_investigation_note", {
    kind: "observation",
    text: "The first recorded response is available below. This query caps its input at ten matching rows: its count is not a total error count or an error rate. Next, inspect event classifications in another bounded sample.",
    evidence_ids: [firstId],
  });
  const second = await call(router.name, {
    intent: "Group a bounded recent error sample by event classification",
    command: "kusto_query",
    parameters: {
      ...common,
      query: "event\n| where ['time'] > ago(1h)\n| where data_event_Name == \"PowerAppsClient.Error\" or data_scenarioResult == \"Failed\"\n| take 100\n| summarize SampleCount = count() by data_event_Name\n| order by SampleCount desc\n| take 10",
    },
  });
  console.log("Second query response:", JSON.stringify(second));
  const secondId = evidenceId(second);
  await call("record_investigation_note", {
    kind: "conclusion",
    text: "This demonstrates two recorded Kusto tool calls and evidence-linked commentary. Inspect the responses to establish query success and sampled counts. These bounded samples do not establish incident impact, a trend, or root cause. A real investigating agent should record its own evidence-based interpretations here.",
    evidence_ids: [firstId, secondId],
  });
  const exported = await call("get_investigation_notebook", {});
  for (const block of exported.content) if (block.type === "text") console.log(block.text);
} catch (error) {
  console.error("Live demonstration failed:", error);
  process.exitCode = 1;
} finally {
  await client.close();
  await transport.close();
}
