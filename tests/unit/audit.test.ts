import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { confirmField, withConfirm } from "../../src/lib/safety.js";
import { dataResult, defineTool, textResult, toolModule } from "../../src/lib/types.js";
import { createAuditModule } from "../../src/tools/audit/handler.js";
import { createCalendarModule } from "../../src/tools/calendar/handler.js";
import { createContactsModule } from "../../src/tools/contacts/handler.js";
import { createFilesModule } from "../../src/tools/files/handler.js";
import { createFinderModule } from "../../src/tools/finder/handler.js";
import { createMailModule } from "../../src/tools/mail/handler.js";
import { createMapsModule } from "../../src/tools/maps/handler.js";
import { createMessagesModule } from "../../src/tools/messages/handler.js";
import { createMusicModule } from "../../src/tools/music/handler.js";
import { createNotesModule } from "../../src/tools/notes/handler.js";
import { createObsidianModule } from "../../src/tools/obsidian/handler.js";
import { createPdfModule } from "../../src/tools/pdf/handler.js";
import { createRemindersModule } from "../../src/tools/reminders/handler.js";
import { createShortcutsModule } from "../../src/tools/shortcuts/handler.js";

let dir: string;
let log: string;
const ENV_KEYS = ["APPLE_MCP_AUDIT_LOG", "APPLE_MCP_AUDIT_MAX_BYTES"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "apple-mcp-audit-"));
	log = join(dir, "logs", "audit.jsonl");
	process.env.APPLE_MCP_AUDIT_LOG = log;
	delete process.env.APPLE_MCP_AUDIT_MAX_BYTES;
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
	rmSync(dir, { recursive: true, force: true });
});

function lines(): Record<string, any>[] {
	if (!existsSync(log)) return [];
	return readFileSync(log, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

const mod = toolModule([
	defineTool({
		name: "peek",
		effect: "read",
		description: "read",
		schema: z.object({ id: z.string() }),
		async run() {
			return textResult("ok");
		},
	}),
	defineTool({
		name: "send_email_like",
		effect: "external",
		description: "send",
		schema: z.object({
			to: z.array(z.string()),
			subject: z.string(),
			body: z.string(),
			confirm: confirmField,
		}),
		async run(a) {
			return withConfirm(
				a.confirm,
				() => "x",
				async () => textResult("sent"),
			);
		},
	}),
	defineTool({
		name: "create_note_like",
		effect: "write",
		description: "create",
		schema: z.object({ title: z.string(), content: z.string(), folder: z.string().optional() }),
		async run(a) {
			if (a.title === "boom") throw new Error("kaput");
			return textResult("created");
		},
	}),
]);

describe("audit logging", () => {
	test("read tools are not logged; write/external are", async () => {
		await mod.handle("peek", { id: "1" });
		expect(lines()).toHaveLength(0);
		await mod.handle("create_note_like", { title: "t", content: "c" });
		const [e] = lines();
		expect(e?.tool).toBe("create_note_like");
		expect(e?.effect).toBe("write");
		expect(e?.mode).toBe("direct");
		expect(e?.outcome).toBe("ok");
		expect(typeof e?.ms).toBe("number");
		expect(Number.isNaN(Date.parse(e?.ts))).toBe(false);
	});

	test("confirmed / previewed modes", async () => {
		const a = { to: ["a@b.c"], subject: "S", body: "B" };
		await mod.handle("send_email_like", a);
		await mod.handle("send_email_like", { ...a, confirm: true });
		const [p, c] = lines();
		expect(p?.mode).toBe("previewed");
		expect(c?.mode).toBe("confirmed");
		expect(p?.effect).toBe("external");
		expect(p?.target.to).toEqual(["a@b.c"]);
	});

	test("errors are logged with outcome error", async () => {
		const r = await mod.handle("create_note_like", { title: "boom", content: "c" });
		expect(r.isError).toBe(true);
		const [e] = lines();
		expect(e?.outcome).toBe("error");
		expect(e?.error).toBe("kaput");
	});

	test("invalid args are not logged", async () => {
		await mod.handle("create_note_like", {});
		expect(lines()).toHaveLength(0);
	});

	test("privacy: content never appears, only lengths", async () => {
		await mod.handle("send_email_like", {
			to: ["x@y.z"],
			subject: "SECRET-SUBJECT",
			body: "SECRET-BODY-TEXT",
			confirm: true,
		});
		await mod.handle("create_note_like", {
			title: "SECRET-TITLE",
			content: "SECRET-CONTENT",
			folder: "Work",
		});
		const raw = readFileSync(log, "utf8");
		expect(raw).not.toContain("SECRET");
		const [a, b] = lines();
		expect(a?.target).toEqual({ to: ["x@y.z"], subjectLen: 14, bodyLen: 16 });
		expect(b?.target).toEqual({ titleLen: 12, contentLen: 14, folder: "Work" });
	});

	test("unknown keys omitted; strings capped; arrays truncated", async () => {
		const m = toolModule([
			defineTool({
				name: "w",
				effect: "write",
				description: "w",
				schema: z.object({
					path: z.string(),
					ids: z.array(z.string()),
					mystery: z.string(),
				}),
				async run() {
					return textResult("ok");
				},
			}),
		]);
		await m.handle("w", {
			path: "p".repeat(500),
			ids: ["1", "2", "3", "4", "5", "6", "7"],
			mystery: "nope",
		});
		const [e] = lines();
		expect(e?.target.mystery).toBeUndefined();
		expect(e?.target.path.length).toBeLessThan(130);
		expect(e?.target.ids).toEqual({ items: ["1", "2", "3", "4", "5"], count: 7 });
	});

	test("auditTarget override is sanitized", async () => {
		const m = toolModule([
			defineTool({
				name: "w",
				effect: "write",
				description: "w",
				schema: z.object({ a: z.string() }),
				auditTarget: (x) => ({ custom: "c".repeat(300), nested: { no: 1 } }),
				async run() {
					return textResult("ok");
				},
			}),
		]);
		await m.handle("w", { a: "x" });
		const [e] = lines();
		expect(e?.target.custom.length).toBeLessThan(130);
		expect(e?.target.nested).toBeUndefined();
	});

	test("file mode 0600, dir 0700", async () => {
		await mod.handle("create_note_like", { title: "t", content: "c" });
		expect(statSync(log).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, "logs")).mode & 0o777).toBe(0o700);
	});

	test("rotation at threshold overwrites .1", async () => {
		process.env.APPLE_MCP_AUDIT_MAX_BYTES = "300";
		for (let i = 0; i < 12; i++) {
			await mod.handle("create_note_like", { title: "t", content: "c" });
		}
		expect(existsSync(`${log}.1`)).toBe(true);
		expect(statSync(log).size).toBeLessThan(600);
		expect(lines().length).toBeGreaterThan(0);
	});

	test("logging failure never breaks the call", async () => {
		process.env.APPLE_MCP_AUDIT_LOG = join(dir, "file-not-dir", "x", "audit.jsonl");
		writeFileSync(join(dir, "file-not-dir"), "x");
		const r = await mod.handle("create_note_like", { title: "t", content: "c" });
		expect(r.isError).toBeUndefined();
	});
});

describe("get_audit_log", () => {
	const audit = createAuditModule();
	const call = async (args: unknown): Promise<any[]> => {
		const r = await audit.handle("get_audit_log", args);
		const text = (r.content[0] as { text: string }).text;
		return JSON.parse(text.slice(text.indexOf("\n\n") + 2));
	};

	function entry(tool: string, ts: string): string {
		return JSON.stringify({ ts, tool, effect: "write", mode: "direct", outcome: "ok" });
	}

	test("newest first, limit, tool filter, since, malformed tolerance, reads .1", async () => {
		await mod.handle("create_note_like", { title: "t", content: "c" }); // creates dir
		rmSync(log);
		writeFileSync(`${log}.1`, `${entry("old", "2026-01-01T00:00:00Z")}\n`);
		writeFileSync(
			log,
			`${[
				entry("a", "2026-02-01T00:00:00Z"),
				"{not json",
				entry("b", "2026-03-01T00:00:00Z"),
				"",
				entry("a", "2026-04-01T00:00:00Z"),
			].join("\n")}\n`,
		);
		expect((await call({})).map((e) => e.tool)).toEqual(["a", "b", "a", "old"]);
		expect((await call({ limit: 2 })).map((e) => e.ts)).toEqual([
			"2026-04-01T00:00:00Z",
			"2026-03-01T00:00:00Z",
		]);
		expect(await call({ tool: "a" })).toHaveLength(2);
		expect(await call({ since: "2026-03-15T00:00:00Z" })).toHaveLength(1);
	});

	test("does not log itself; empty log ok; validates limit", async () => {
		expect(await call({})).toEqual([]);
		expect(existsSync(log)).toBe(false);
		const r = await audit.handle("get_audit_log", { limit: 501 });
		expect(r.isError).toBe(true);
		const r2 = await audit.handle("get_audit_log", { since: "garbage" });
		expect(r2.isError).toBe(true);
	});
});

describe("annotations", () => {
	test("effect maps to MCP annotations", () => {
		const byName = Object.fromEntries(mod.tools.map((t) => [t.name, t.annotations]));
		expect(byName.peek).toEqual({ readOnlyHint: true, openWorldHint: false });
		expect(byName.send_email_like).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		});
		expect(byName.create_note_like).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			openWorldHint: false,
		});
	});

	test("confirm-gated write tool is destructive; openWorld override on read", () => {
		const m = toolModule([
			defineTool({
				name: "del",
				effect: "write",
				description: "d",
				schema: z.object({ id: z.string(), confirm: confirmField }),
				async run() {
					return dataResult("x", {});
				},
			}),
			defineTool({
				name: "geo",
				effect: "read",
				openWorld: true,
				description: "g",
				schema: z.object({}),
				async run() {
					return textResult("x");
				},
			}),
		]);
		expect(m.tools[0]?.annotations?.destructiveHint).toBe(true);
		expect(m.tools[1]?.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
	});

	test("every real tool has annotations; confirm-gated tools are never read", () => {
		const modules = [
			createRemindersModule(),
			createCalendarModule(),
			createNotesModule(),
			createMessagesModule(),
			createContactsModule(),
			createMapsModule(),
			createMailModule(),
			createPdfModule(),
			createFilesModule(),
			createFinderModule(),
			createShortcutsModule(),
			createMusicModule(),
			createObsidianModule(),
			createAuditModule(),
		];
		const tools = modules.flatMap((m) => m.tools);
		expect(tools.length).toBeGreaterThanOrEqual(79);
		for (const t of tools) {
			expect(t.annotations).toBeDefined();
			const props = (t.inputSchema.properties ?? {}) as Record<string, unknown>;
			if ("confirm" in props) {
				expect(t.annotations?.readOnlyHint).toBe(false);
				expect(t.annotations?.destructiveHint).toBe(true);
			}
		}
		const ann = (n: string) => tools.find((t) => t.name === n)?.annotations;
		for (const n of ["send_email", "reply_email", "send_message", "run_shortcut"]) {
			expect(ann(n)?.openWorldHint).toBe(true);
		}
		expect(ann("list_reminders")?.readOnlyHint).toBe(true);
	});
});

describe("audit privacy: errors and places", () => {
	test("error text echoing user input is redacted", async () => {
		const m = toolModule([
			defineTool({
				name: "rename_thing",
				effect: "write",
				description: "w",
				schema: z.object({ id: z.string(), title: z.string() }),
				async run(a) {
					throw new Error(`No item "${a.title}" in list ${a.id}`);
				},
			}),
		]);
		const res = await m.handle("rename_thing", { id: "abc", title: "Secret Plan B" });
		expect(res.isError).toBe(true);
		const [line] = lines();
		expect(line.outcome).toBe("error");
		expect(JSON.stringify(line)).not.toContain("Secret Plan B");
		expect(line.error).toBe('No item "[redacted]" in list [redacted]');
	});

	test("open_in_maps logs place lengths, not addresses", async () => {
		const maps = createMapsModule({
			openUrl: async () => {},
		} as unknown as Parameters<typeof createMapsModule>[0]);
		await maps.handle("open_in_maps", { from: "1 Home Street", to: "Clinic Road 5" });
		const [line] = lines();
		expect(line.tool).toBe("open_in_maps");
		expect(JSON.stringify(line)).not.toContain("Home Street");
		expect(JSON.stringify(line)).not.toContain("Clinic Road");
		expect(line.target).toEqual({ fromLen: 13, toLen: 13 });
	});
});
