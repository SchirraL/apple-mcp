import { describe, expect, test } from "bun:test";
import {
	bridgeUrl,
	errorFor,
	flatten,
	forward,
	isRequest,
	parseLine,
	parseSse,
	type SessionState,
} from "../../src/bridge.js";

const fakeFetch = (res: Response | Error): typeof fetch =>
	(async () => {
		if (res instanceof Error) throw res;
		return res;
	}) as unknown as typeof fetch;

describe("parseSse", () => {
	test("extracts JSON data events", () => {
		const text = 'event: message\ndata: {"id":1}\n\nevent: message\ndata: {"id":2}\n\n';
		expect(parseSse(text)).toEqual([{ id: 1 }, { id: 2 }]);
	});
	test("joins multi-line data and skips junk/comments", () => {
		expect(parseSse(': ping\n\ndata: {"a":\ndata: 1}\n\ndata: nope\n\n')).toEqual([{ a: 1 }]);
	});
	test("handles CRLF", () => {
		expect(parseSse('data: {"x":1}\r\n\r\n')).toEqual([{ x: 1 }]);
	});
});

describe("errorFor", () => {
	test("request gets -32000 error with same id", () => {
		const e = errorFor({ jsonrpc: "2.0", id: 7, method: "tools/list" }, "not-running");
		expect(e?.id).toBe(7);
		expect((e as any).error.code).toBe(-32000);
		expect((e as any).error.message).toContain("service is not running");
	});
	test("notification gets nothing", () => {
		expect(errorFor({ jsonrpc: "2.0", method: "notifications/initialized" }, "not-running")).toBeNull();
	});
	test("unauthorized message", () => {
		const e = errorFor({ id: 1, method: "x" }, "unauthorized");
		expect((e as any).error.message).toContain("401");
	});
	test("isRequest", () => {
		expect(isRequest({ id: 0, method: "a" })).toBe(true);
		expect(isRequest({ id: 1 })).toBe(false);
		expect(isRequest({ method: "a" })).toBe(false);
	});
});

describe("forward", () => {
	const req = { jsonrpc: "2.0", id: 1, method: "tools/list" };
	test("single JSON object and array", async () => {
		const json = { "content-type": "application/json" };
		const one = await forward(req, "t", {}, "u", fakeFetch(new Response('{"id":1}', { headers: json })));
		expect(one).toEqual([{ id: 1 }]);
		const many = await forward(req, "t", {}, "u", fakeFetch(new Response('[{"id":1},{"id":2}]', { headers: json })));
		expect(many).toHaveLength(2);
		expect(flatten([1])).toEqual([1]);
	});
	test("202 yields nothing", async () => {
		expect(await forward(req, "t", {}, "u", fakeFetch(new Response(null, { status: 202 })))).toEqual([]);
	});
	test("SSE response forwarded", async () => {
		const res = new Response('data: {"id":1}\n\n', { headers: { "content-type": "text/event-stream" } });
		expect(await forward(req, "t", {}, "u", fakeFetch(res))).toEqual([{ id: 1 }]);
	});
	test("connection refused -> error for request, nothing for notification", async () => {
		const f = fakeFetch(new TypeError("fetch failed: ECONNREFUSED"));
		const out = await forward(req, "t", {}, "u", f);
		expect((out[0] as any).error.code).toBe(-32000);
		expect(await forward({ method: "notifications/initialized" }, "t", {}, "u", f)).toEqual([]);
	});
	test("401 -> auth error", async () => {
		const out = await forward(req, "t", {}, "u", fakeFetch(new Response("no", { status: 401 })));
		expect((out[0] as any).error.message).toContain("bearer token");
	});
	test("session id and protocol version are captured and echoed", async () => {
		const state: SessionState = {};
		const init = { jsonrpc: "2.0", id: 1, method: "initialize" };
		const res = new Response('{"id":1,"result":{"protocolVersion":"2025-06-18"}}', {
			headers: { "content-type": "application/json", "mcp-session-id": "abc" },
		});
		await forward(init, "t", state, "u", fakeFetch(res));
		expect(state).toEqual({ sessionId: "abc", protocolVersion: "2025-06-18" });
		let seen: Headers | undefined;
		const spy = (async (_u: string, init: RequestInit) => {
			seen = new Headers(init.headers);
			return new Response(null, { status: 202 });
		}) as unknown as typeof fetch;
		await forward(req, "tok", state, "u", spy);
		expect(seen?.get("mcp-session-id")).toBe("abc");
		expect(seen?.get("mcp-protocol-version")).toBe("2025-06-18");
		expect(seen?.get("authorization")).toBe("Bearer tok");
	});
});

describe("parseLine", () => {
	test("parses objects, ignores blanks/garbage", () => {
		expect(parseLine('{"id":1}')).toEqual({ id: 1 });
		expect(parseLine("  ")).toBeNull();
		expect(parseLine("nope")).toBeNull();
	});
});

describe("bridgeUrl", () => {
	test("adds ?apps= for --apps and leaves the base URL alone otherwise", () => {
		expect(bridgeUrl([], "http://h/mcp")).toBe("http://h/mcp");
		expect(bridgeUrl(["--apps", "notes,mail"], "http://h/mcp")).toBe(
			"http://h/mcp?apps=notes%2Cmail",
		);
	});
	test("--apps without a value is an error", () => {
		expect(() => bridgeUrl(["--apps"], "http://h/mcp")).toThrow(/comma-separated/);
	});
});
