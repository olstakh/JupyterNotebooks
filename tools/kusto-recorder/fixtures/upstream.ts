import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fixture-kusto", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "kusto", description: "Fixture Kusto router", inputSchema: { type: "object", properties: {} } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: "text", text: JSON.stringify({ received: request.params.arguments }) }],
  isError: request.params.arguments?.command === "fail",
}));
await server.connect(new StdioServerTransport());
