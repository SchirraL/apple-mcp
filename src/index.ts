#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callTool, hasTool, registeredTools } from "./registry.js";
import { errorResult } from "./lib/types.js";

// Server bootstrap only: every tool lives in src/tools/<app> and is wired in registry.ts.
// stdout is the MCP channel — log to stderr only.

const VERSION = "1.1.0";

async function main(): Promise<void> {
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

	await server.connect(new StdioServerTransport());
	console.error(`apple-mcp ${VERSION} running on stdio (${registeredTools.length} tools)`);
}

main().catch((error: unknown) => {
	console.error("Fatal error starting apple-mcp:", error);
	process.exit(1);
});
