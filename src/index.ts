#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startHttpServer } from "./http.js";
import { registeredTools } from "./registry.js";
import { createMcpServer, VERSION } from "./server.js";
import { getOrCreateToken, servicePort } from "./lib/service-config.js";

// Entry point. Default: stdio (client spawns the server). `--http`: local service mode, run
// by launchd (see scripts/service.ts). stdout is the MCP channel in stdio mode — stderr only.

async function main(): Promise<void> {
	if (process.argv.includes("--http")) {
		await startHttpServer({ port: servicePort(), token: getOrCreateToken() });
		return;
	}
	await createMcpServer().connect(new StdioServerTransport());
	console.error(`apple-mcp ${VERSION} running on stdio (${registeredTools.length} tools)`);
}

main().catch((error: unknown) => {
	console.error("Fatal error starting apple-mcp:", error);
	process.exit(1);
});
