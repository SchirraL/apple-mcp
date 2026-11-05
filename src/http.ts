import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { enabledApps, parseClientApps, registeredTools } from "./registry.js";
import { createMcpServer, VERSION } from "./server.js";
import { HEALTH_PATH, HOST, MCP_PATH } from "./lib/service-config.js";

// Local HTTP service mode (launchd). This server can send mail and iMessages, so it is locked
// down: loopback bind only, Host allowlist (DNS rebinding), no browser Origins, bearer token.

const MAX_BODY = 4 * 1024 * 1024;

export interface HttpOptions {
	port: number;
	token: string;
}

/** Pure request gate — exported for unit tests. Returns null when allowed. */
export function checkRequest(
	headers: IncomingMessage["headers"],
	port: number,
	token: string,
): { status: number; message: string } | null {
	const host = String(headers.host ?? "");
	const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
	if (!allowedHosts.includes(host)) return { status: 421, message: "Host not allowed" };
	// Browsers always send Origin on cross-origin POSTs; MCP clients don't need it.
	if (headers.origin !== undefined) {
		return { status: 403, message: "Browser origins are not allowed" };
	}
	const auth = String(headers.authorization ?? "");
	const m = /^Bearer (.+)$/.exec(auth);
	if (!m || !safeEqual(m[1].trim(), token)) {
		return { status: 401, message: "Missing or invalid bearer token" };
	}
	return null;
}

function safeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > MAX_BODY) {
				reject(Object.assign(new Error("Request body too large"), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			if (size === 0) return resolve(undefined);
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(Object.assign(new Error("Invalid JSON"), { status: 400 }));
			}
		});
		req.on("error", reject);
	});
}

/** `?apps=a,b` → that client's app subset; throws (status 400) on unknown/disabled apps. */
export function clientAppsFromUrl(url: string | undefined): string[] | undefined {
	const raw = new URL(url ?? "/", "http://localhost").searchParams.get("apps");
	if (raw === null) return undefined;
	try {
		return parseClientApps(raw);
	} catch (error) {
		throw Object.assign(new Error((error as Error).message), { status: 400 });
	}
}

async function handleMcp(
	req: IncomingMessage,
	res: ServerResponse,
	clientApps: string[] | undefined,
): Promise<void> {
	// Stateless: one server + transport per request. Tool modules are shared and cheap.
	const server = createMcpServer(clientApps);
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	res.on("close", () => {
		void transport.close();
		void server.close();
	});
	await server.connect(transport);
	const body = req.method === "POST" ? await readBody(req) : undefined;
	await transport.handleRequest(req, res, body);
}

export function startHttpServer(opts: HttpOptions): Promise<void> {
	const httpServer = createServer(async (req, res) => {
		const path = (req.url ?? "/").split("?")[0];
		try {
			if (path === HEALTH_PATH && req.method === "GET") {
				return sendJson(res, 200, {
					ok: true,
					version: VERSION,
					tools: registeredTools.length,
					apps: enabledApps,
				});
			}
			if (path !== MCP_PATH) return sendJson(res, 404, { error: "Not found" });
			const denied = checkRequest(req.headers, opts.port, opts.token);
			if (denied) return sendJson(res, denied.status, { error: denied.message });
			if (req.method === "GET" || req.method === "DELETE") {
				// Stateless server: no standalone SSE stream, no sessions to delete.
				res.writeHead(405, { Allow: "POST" }).end();
				return;
			}
			await handleMcp(req, res, clientAppsFromUrl(req.url));
		} catch (error) {
			const status = (error as { status?: number }).status ?? 500;
			if (status === 500) console.error("[http]", error);
			if (!res.headersSent) sendJson(res, status, { error: (error as Error).message });
		}
	});
	httpServer.requestTimeout = 330_000; // longer than the slowest tool (run_shortcut ≤ 300s)
	return new Promise((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(opts.port, HOST, () => {
			console.error(
				`apple-mcp ${VERSION} listening on http://${HOST}:${opts.port}${MCP_PATH} ` +
					`(${registeredTools.length} tools)`,
			);
			resolve();
		});
	});
}
