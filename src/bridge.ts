import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { getOrCreateToken, serviceUrl } from "./lib/service-config.js";

// stdio <-> HTTP bridge for MCP clients that only speak stdio (e.g. Claude Desktop).
// Reads newline-delimited JSON-RPC on stdin, POSTs each message to the running service and
// writes the responses to stdout. Logs go to stderr only.

export type JsonRpcId = string | number | null;

export interface JsonRpcMessage {
	jsonrpc?: string;
	id?: JsonRpcId;
	method?: string;
	[key: string]: unknown;
}

export type FailureReason = "not-running" | "unauthorized" | "http" | "invalid";

export const NOT_RUNNING_MESSAGE =
	"apple-mcp service is not running — run `bun run scripts/service.ts install` (or status)";

/** A message is a request (expects a response) when it has a method and an id. */
export function isRequest(message: JsonRpcMessage): boolean {
	return typeof message.method === "string" && message.id !== undefined && message.id !== null;
}

/** Build a JSON-RPC error reply for a request; null for notifications/responses. */
export function errorFor(
	message: JsonRpcMessage,
	reason: FailureReason,
	detail?: string,
): JsonRpcMessage | null {
	if (!isRequest(message)) return null;
	let text: string;
	switch (reason) {
		case "not-running":
			text = NOT_RUNNING_MESSAGE;
			break;
		case "unauthorized":
			text =
				"apple-mcp service rejected the bearer token (401) — check " +
				"~/Library/Application Support/apple-mcp/token / APPLE_MCP_TOKEN";
			break;
		case "invalid":
			text = detail ?? "apple-mcp service returned an invalid response";
			break;
		default:
			text = detail ?? "apple-mcp service request failed";
	}
	return { jsonrpc: "2.0", id: message.id as JsonRpcId, error: { code: -32000, message: text } };
}

/** Parse an SSE body and return the JSON payload of every `data:` event. */
export function parseSse(text: string): unknown[] {
	const out: unknown[] = [];
	for (const rawEvent of text.split(/\r?\n\r?\n/)) {
		const data: string[] = [];
		for (const line of rawEvent.split(/\r?\n/)) {
			if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
		}
		if (data.length === 0) continue;
		try {
			out.push(JSON.parse(data.join("\n")));
		} catch {
			// ignore non-JSON events
		}
	}
	return out;
}

/** Turn a JSON body (object or array) into a flat list of messages. */
export function flatten(payload: unknown): unknown[] {
	return Array.isArray(payload) ? payload : [payload];
}

export interface SessionState {
	sessionId?: string;
	protocolVersion?: string;
}

export function buildHeaders(token: string, state: SessionState): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		Authorization: `Bearer ${token}`,
	};
	if (state.sessionId) headers["Mcp-Session-Id"] = state.sessionId;
	if (state.protocolVersion) headers["MCP-Protocol-Version"] = state.protocolVersion;
	return headers;
}

function isConnectionRefused(error: unknown): boolean {
	const text = (e: unknown): string => {
		if (!(e instanceof Error)) return String(e);
		const cause = (e as { cause?: unknown }).cause;
		const code = (e as { code?: string }).code ?? "";
		return `${e.message} ${code} ${cause ? text(cause) : ""}`;
	};
	return /ECONNREFUSED|ConnectionRefused|Unable to connect|fetch failed|ECONNRESET/i.test(
		text(error),
	);
}

/** Forward one message; returns the messages to write to stdout. */
export async function forward(
	message: JsonRpcMessage,
	token: string,
	state: SessionState,
	url: string = serviceUrl(),
	fetchImpl: typeof fetch = fetch,
): Promise<unknown[]> {
	const fail = (reason: FailureReason, detail?: string): unknown[] => {
		const reply = errorFor(message, reason, detail);
		return reply ? [reply] : [];
	};
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "POST",
			headers: buildHeaders(token, state),
			body: JSON.stringify(message),
		});
	} catch (error) {
		console.error("[apple-mcp bridge] request failed:", error);
		return fail(isConnectionRefused(error) ? "not-running" : "http", String(error));
	}
	const sessionId = response.headers.get("mcp-session-id");
	if (sessionId) state.sessionId = sessionId;
	if (response.status === 401 || response.status === 403) return fail("unauthorized");
	if (response.status === 202 || response.status === 204) return [];
	const body = await response.text();
	if (!response.ok && !body.trim()) return fail("http", `apple-mcp HTTP ${response.status}`);
	if (!body.trim()) return [];
	const type = response.headers.get("content-type") ?? "";
	let payloads: unknown[];
	if (type.includes("text/event-stream")) {
		payloads = parseSse(body);
	} else {
		try {
			payloads = flatten(JSON.parse(body));
		} catch {
			return fail("invalid", `apple-mcp returned non-JSON (HTTP ${response.status})`);
		}
	}
	if (message.method === "initialize") {
		for (const p of payloads) {
			const v = (p as { result?: { protocolVersion?: unknown } }).result?.protocolVersion;
			if (typeof v === "string") state.protocolVersion = v;
		}
	}
	return payloads;
}

export function parseLine(line: string): JsonRpcMessage | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const value = JSON.parse(trimmed) as unknown;
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as JsonRpcMessage)
			: null;
	} catch {
		console.error("[apple-mcp bridge] ignoring non-JSON input line");
		return null;
	}
}

function run(): void {
	const token = getOrCreateToken();
	const state: SessionState = {};
	const rl = createInterface({ input: process.stdin });
	// Chain keeps ordering without blocking stdin reading.
	let chain: Promise<void> = Promise.resolve();
	rl.on("line", (line) => {
		const message = parseLine(line);
		if (!message) return;
		chain = chain.then(async () => {
			try {
				for (const out of await forward(message, token, state)) {
					process.stdout.write(`${JSON.stringify(out)}\n`);
				}
			} catch (error) {
				console.error("[apple-mcp bridge] unexpected error:", error);
				const reply = errorFor(message, "http", String(error));
				if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
			}
		});
	});
	rl.on("close", () => {
		void chain.then(() => process.exit(0));
	});
}

const isMain =
	typeof process.argv[1] === "string" &&
	(process.argv[1] === fileURLToPath(import.meta.url) ||
		process.argv[1].endsWith("bridge.js"));
if (isMain) run();
