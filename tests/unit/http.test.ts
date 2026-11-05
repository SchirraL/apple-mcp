import { describe, expect, test } from "bun:test";
import { checkRequest, clientAppsFromUrl } from "../../src/http.js";

const TOKEN = "t".repeat(43);
const ok = { host: "127.0.0.1:47823", authorization: `Bearer ${TOKEN}` };

describe("checkRequest", () => {
	test("allows loopback host with the right token", () => {
		expect(checkRequest(ok, 47823, TOKEN)).toBeNull();
		expect(checkRequest({ ...ok, host: "localhost:47823" }, 47823, TOKEN)).toBeNull();
	});

	test("rejects foreign or missing Host (DNS rebinding)", () => {
		expect(checkRequest({ ...ok, host: "evil.example:47823" }, 47823, TOKEN)?.status).toBe(421);
		expect(checkRequest({ ...ok, host: "127.0.0.1:1234" }, 47823, TOKEN)?.status).toBe(421);
		expect(checkRequest({ authorization: ok.authorization }, 47823, TOKEN)?.status).toBe(421);
	});

	test("rejects any browser Origin, even with a valid token", () => {
		const res = checkRequest({ ...ok, origin: "http://127.0.0.1:47823" }, 47823, TOKEN);
		expect(res?.status).toBe(403);
	});

	test("rejects missing, malformed or wrong tokens", () => {
		expect(checkRequest({ host: ok.host }, 47823, TOKEN)?.status).toBe(401);
		expect(checkRequest({ ...ok, authorization: TOKEN }, 47823, TOKEN)?.status).toBe(401);
		expect(checkRequest({ ...ok, authorization: "Bearer x" }, 47823, TOKEN)?.status).toBe(401);
		const longer = `Bearer ${TOKEN}x`;
		expect(checkRequest({ ...ok, authorization: longer }, 47823, TOKEN)?.status).toBe(401);
	});
});

describe("clientAppsFromUrl", () => {
	test("no ?apps → all enabled apps", () => {
		expect(clientAppsFromUrl("/mcp")).toBeUndefined();
	});
	test("?apps=a,b → that subset", () => {
		expect(clientAppsFromUrl("/mcp?apps=notes,mail")).toEqual(["notes", "mail"]);
		expect(clientAppsFromUrl("/mcp?apps=notes%2Cmail")).toEqual(["notes", "mail"]);
	});
	test("unknown app → 400", () => {
		try {
			clientAppsFromUrl("/mcp?apps=nope");
			throw new Error("expected throw");
		} catch (e) {
			expect((e as { status?: number }).status).toBe(400);
			expect((e as Error).message).toMatch(/Unknown app/);
		}
	});
});
