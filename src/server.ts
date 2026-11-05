import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { errorResult } from "./lib/types.js";
import { callTool, toolAllowed, toolsFor } from "./registry.js";

export const VERSION = "1.2.0";

/**
 * A fresh MCP Server wired to the registry. Cheap: modules are shared, not re-created.
 * `clientApps` limits both the tool list and what may be called (undefined = all enabled).
 */
export function createMcpServer(clientApps?: readonly string[]): Server {
	const server = new Server(
		{ name: "apple-mcp", version: VERSION },
		{ capabilities: { tools: {} } },
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolsFor(clientApps) }));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args } = request.params;
		if (!toolAllowed(name, clientApps)) return errorResult(`Unknown tool: ${name}`);
		return callTool(name, args ?? {});
	});
	return server;
}
