import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const custom = process.env.RECORDER_TEST_CUSTOM === "1";
const server = new Server({ name: "fixture-kusto", version: "1.0.0" }, {
  capabilities: { tools: {} },
  instructions: "Fixture upstream instructions must survive wrapping.",
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: custom ? [{
    name: "run_team_query", description: "Team-owned query tool",
    inputSchema: { type: "object", properties: { kql: { type: "string" } }, required: ["kql"] },
  }] : [{ name: "kusto", description: "Fixture Kusto router", inputSchema: { type: "object", properties: {} } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: "text", text: JSON.stringify({ received: request.params.arguments }) }],
  isError: request.params.arguments?.command === "fail",
  ...(custom ? {
    structuredContent: {
      cwd: process.cwd(), argv: process.argv.slice(2), received: request.params,
      teamSetting: process.env.RECORDER_TEST_SETTING,
    },
    _meta: { fixture: "unchanged" },
  } : {}),
}));
await server.connect(new StdioServerTransport());
