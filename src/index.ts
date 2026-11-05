#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getOrCreateToken, servicePort } from "./lib/service-config.js";

// Entry point. Default: stdio (client spawns the server). `--http`: local service mode, run
// by launchd (see scripts/service.ts). stdout is the MCP channel in stdio mode — stderr only.
// The registry is imported dynamically so a bad APPLE_MCP_APPS fails with a one-line error.

async function main(): Promise<void> {
	if (process.argv.includes("--doctor")) {
		const { runDoctor, formatReport } = await import("./tools/doctor/handler.js");
		const report = await runDoctor();
		console.log(process.argv.includes("--json") ? JSON.stringify(report) : formatReport(report));
		process.exit(report.checks.some((c) => c.status === "denied") ? 1 : 0);
	}
	const { registeredTools } = await import("./registry.js");
	if (process.argv.includes("--http")) {
		const { startHttpServer } = await import("./http.js");
		await startHttpServer({ port: servicePort(), token: getOrCreateToken() });
		return;
	}
	const { createMcpServer, VERSION } = await import("./server.js");
	await createMcpServer().connect(new StdioServerTransport());
	console.error(`apple-mcp ${VERSION} running on stdio (${registeredTools.length} tools)`);
}

main().catch((error: unknown) => {
	console.error("Fatal error starting apple-mcp:", error instanceof Error ? error.message : error);
	process.exit(1);
});
