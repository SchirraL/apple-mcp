import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { errorResult } from "./lib/types.js";
import { callTool, hasTool, registeredTools } from "./registry.js";

export const VERSION = "1.2.0";

/** A fresh MCP Server wired to the registry. Cheap: modules are shared, not re-created. */
export function createMcpServer(): Server {
	const server = new Server(
		{ name: "apple-mcp", version: VERSION },
		{ capabilities: { tools: {} } },
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: registeredTools }));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args } = request.params;
		if (!hasTool(name)) return errorResult(`Unknown tool: ${name}`);
		return callTool(name, args ?? {});
	});
	return server;
}
