import { beforeEach, describe, expect, test } from "bun:test";
import type { ToolModule } from "../../src/lib/types.js";
import {
	type Email,
	type EmailListQuery,
	type EmailSearchQuery,
	type EmailSummary,
	type MailAccount,
	type MailBridge,
	type MailFolder,
	type MoveTarget,
	type NewEmail,
	type ReplyOptions,
	parseMailboxUrl,
	selectMailboxes,
	sqlText,
	stripAngles,
} from "../../src/tools/mail/bridge.js";
import { createMailModule, isTrashOrJunk } from "../../src/tools/mail/handler.js";

const summary: EmailSummary = {
	id: "abc@example.com",
	subject: "Hello",
	from: "Ann <ann@example.com>",
	date: "2026-11-05T10:00:00.000Z",
	read: false,
	flagged: false,
	account: "iCloud",
	folder: "INBOX",
	snippet: "hi there",
};
const email: Email = { ...summary, to: ["me@example.com"], cc: [], body: "Hi", attachments: [] };

class FakeBridge implements MailBridge {
	calls: { method: string; args: unknown[] }[] = [];
	error: Error | null = null;
	target: MoveTarget = { account: "uuid", accountName: "iCloud", path: "Archive" };

	private record(method: string, ...args: unknown[]): void {
		this.calls.push({ method, args });
		if (this.error) throw this.error;
	}
	callsOf(method: string): unknown[][] {
		return this.calls.filter((c) => c.method === method).map((c) => c.args);
	}
	names(): string[] {
		return this.calls.map((c) => c.method);
	}
	async listAccounts(): Promise<MailAccount[]> {
		this.record("listAccounts");
		return [{ id: "uuid", name: "iCloud", emails: ["me@example.com"] }];
	}
	async listFolders(account?: string): Promise<MailFolder[]> {
		this.record("listFolders", account);
		return [{ account: "iCloud", path: "INBOX", unread: 2, total: 10 }];
	}
	async listEmails(q: EmailListQuery): Promise<EmailSummary[]> {
		this.record("listEmails", q);
		return [summary];
	}
	async searchEmails(q: EmailSearchQuery): Promise<EmailSummary[]> {
		this.record("searchEmails", q);
		return [summary];
	}
	async getEmail(id: string): Promise<Email> {
		this.record("getEmail", id);
		return { ...email, id };
	}
	async createDraft(m: NewEmail): Promise<void> {
		this.record("createDraft", m);
	}
	async sendEmail(m: NewEmail): Promise<void> {
		this.record("sendEmail", m);
	}
	async replyEmail(id: string, o: ReplyOptions): Promise<{ sent: boolean }> {
		this.record("replyEmail", id, o);
		return { sent: o.send };
	}
	async resolveMoveTarget(id: string, folder: string): Promise<MoveTarget> {
		this.record("resolveMoveTarget", id, folder);
		return { ...this.target, path: folder };
	}
	async moveEmail(id: string, target: MoveTarget): Promise<void> {
		this.record("moveEmail", id, target);
	}
	async setRead(id: string, read: boolean): Promise<void> {
		this.record("setRead", id, read);
	}
	async setFlagged(id: string, flagged: boolean): Promise<void> {
		this.record("setFlagged", id, flagged);
	}
}

function text(res: { content: unknown }): string {
	return (res.content as { text: string }[]).map((c) => c.text).join("\n");
}

let bridge: FakeBridge;
let mod: ToolModule;

beforeEach(() => {
	bridge = new FakeBridge();
	mod = createMailModule(bridge);
});

describe("tools list", () => {
	test("exposes exactly the expected tools", () => {
		expect(mod.tools.map((t) => t.name).sort()).toEqual(
			[
				"create_draft",
				"flag_email",
				"list_email_accounts",
				"list_email_folders",
				"list_emails",
				"mark_email_read",
				"move_email",
				"read_email",
				"reply_email",
				"search_emails",
				"send_email",
			].sort(),
		);
	});

	test("inputSchema is an object schema without $schema", () => {
		for (const t of mod.tools) {
			expect(t.inputSchema.type).toBe("object");
			expect("$schema" in t.inputSchema).toBe(false);
		}
	});
});

describe("read-only tools", () => {
	test("list_email_accounts and folders", async () => {
		expect(text(await mod.handle("list_email_accounts", {}))).toContain("me@example.com");
		await mod.handle("list_email_folders", { account: "iCloud" });
		expect(bridge.callsOf("listFolders")[0]).toEqual(["iCloud"]);
	});

	test("list_emails defaults and omits unset filters", async () => {
		const res = await mod.handle("list_emails", {});
		expect(res.isError).toBeUndefined();
		expect(bridge.callsOf("listEmails")[0]![0]).toEqual({ unreadOnly: false, limit: 20 });
	});

	test("list_emails limit bounds", async () => {
		for (const limit of [0, 101, 2.5]) {
			expect((await mod.handle("list_emails", { limit })).isError).toBe(true);
		}
		expect(bridge.calls).toHaveLength(0);
	});

	test("search_emails passes filters and validates dates", async () => {
		await mod.handle("search_emails", { query: "invoice", since: "2026-01-01", folder: "Archive" });
		expect(bridge.callsOf("searchEmails")[0]![0]).toEqual({
			query: "invoice",
			folder: "Archive",
			since: "2026-01-01",
			unreadOnly: false,
			limit: 20,
		});
		expect((await mod.handle("search_emails", { query: "x", since: "nope" })).isError).toBe(true);
		expect((await mod.handle("search_emails", {})).isError).toBe(true);
	});

	test("read_email returns the email", async () => {
		const res = await mod.handle("read_email", { id: "abc@example.com" });
		expect(text(res)).toContain('"body": "Hi"');
	});

	test("bridge errors become tool errors", async () => {
		bridge.error = new Error("No permission");
		const res = await mod.handle("list_emails", {});
		expect(res.isError).toBe(true);
		expect(text(res)).toContain("No permission");
	});
});

describe("create_draft", () => {
	test("needs no confirmation and never sends", async () => {
		const res = await mod.handle("create_draft", { to: ["a@b.co"], subject: "S", body: "B" });
		expect(res.isError).toBeUndefined();
		expect(bridge.names()).toEqual(["createDraft"]);
		expect(bridge.callsOf("createDraft")[0]![0]).toEqual({
			to: ["a@b.co"],
			subject: "S",
			body: "B",
		});
	});

	test("validates addresses and required fields", async () => {
		for (const args of [
			{ to: [], subject: "S", body: "B" },
			{ to: ["not-an-address"], subject: "S", body: "B" },
			{ to: ["a@b.co"], subject: " ", body: "B" },
			{ to: ["a@b.co"], subject: "S", body: "" },
		]) {
			expect((await mod.handle("create_draft", args)).isError).toBe(true);
		}
		expect(bridge.calls).toHaveLength(0);
	});
});

describe("send_email", () => {
	const args = {
		to: ["a@b.co"],
		cc: ["c@d.co"],
		bcc: ["e@f.co"],
		subject: "Subj",
		body: "Body text",
		from: "me@example.com",
	};

	test("without confirm previews everything and sends nothing", async () => {
		const res = await mod.handle("send_email", args);
		expect(res.isError).toBeUndefined();
		const t = text(res);
		expect(t).toContain("PREVIEW");
		for (const s of ["me@example.com", "a@b.co", "c@d.co", "e@f.co", "Subj", "Body text"]) {
			expect(t).toContain(s);
		}
		expect(bridge.callsOf("sendEmail")).toHaveLength(0);
	});

	test("confirm: false still only previews", async () => {
		await mod.handle("send_email", { ...args, confirm: false });
		expect(bridge.callsOf("sendEmail")).toHaveLength(0);
	});

	test("with confirm sends once with all fields", async () => {
		const res = await mod.handle("send_email", { ...args, confirm: true });
		expect(res.isError).toBeUndefined();
		expect(bridge.callsOf("sendEmail")).toEqual([[args]]);
	});
});

describe("reply_email", () => {
	test("default creates a draft without confirm and without reading the original", async () => {
		const res = await mod.handle("reply_email", { id: "x", body: "Thanks" });
		expect(res.isError).toBeUndefined();
		expect(bridge.callsOf("replyEmail")[0]).toEqual([
			"x",
			{ body: "Thanks", replyAll: false, send: false },
		]);
	});

	test("send without confirm previews only", async () => {
		const res = await mod.handle("reply_email", { id: "x", body: "Thanks", send: true });
		expect(text(res)).toContain("PREVIEW");
		expect(text(res)).toContain("Thanks");
		expect(bridge.callsOf("replyEmail")).toHaveLength(0);
	});

	test("send with confirm sends", async () => {
		const res = await mod.handle("reply_email", {
			id: "x",
			body: "Thanks",
			send: true,
			replyAll: true,
			confirm: true,
		});
		expect(text(res)).toContain("Reply sent");
		expect(bridge.callsOf("replyEmail")[0]).toEqual([
			"x",
			{ body: "Thanks", replyAll: true, send: true },
		]);
	});
});

describe("move_email", () => {
	test("normal folder moves directly", async () => {
		const res = await mod.handle("move_email", { id: "x", folder: "Archive" });
		expect(res.isError).toBeUndefined();
		expect(bridge.callsOf("moveEmail")).toHaveLength(1);
	});

	for (const folder of ["Trash", "Deleted Messages", "Junk", "[Gmail]/Spam", "Papierkorb"]) {
		test(`${folder} needs confirm`, async () => {
			const res = await mod.handle("move_email", { id: "x", folder });
			expect(text(res)).toContain("PREVIEW");
			expect(bridge.callsOf("moveEmail")).toHaveLength(0);
			const ok = await mod.handle("move_email", { id: "x", folder, confirm: true });
			expect(ok.isError).toBeUndefined();
			expect(bridge.callsOf("moveEmail")).toHaveLength(1);
		});
	}

	test("isTrashOrJunk is not fooled by similar names", () => {
		expect(isTrashOrJunk("Archive/Trash stuff")).toBe(false);
		expect(isTrashOrJunk("INBOX/Junk")).toBe(true);
	});
});

describe("mark and flag", () => {
	test("mark_email_read defaults to read", async () => {
		await mod.handle("mark_email_read", { id: "x" });
		await mod.handle("mark_email_read", { id: "x", read: false });
		expect(bridge.callsOf("setRead")).toEqual([
			["x", true],
			["x", false],
		]);
	});

	test("flag_email defaults to flagged", async () => {
		await mod.handle("flag_email", { id: "x" });
		await mod.handle("flag_email", { id: "x", flagged: false });
		expect(bridge.callsOf("setFlagged")).toEqual([
			["x", true],
			["x", false],
		]);
	});
});

describe("bridge helpers", () => {
	test("sqlText never leaks user text into SQL", () => {
		const evil = "'; DROP TABLE messages; --";
		const sql = sqlText(evil);
		expect(sql).toMatch(/^CAST\(x'[0-9a-f]+' AS TEXT\)$/);
		expect(sql).not.toContain("DROP");
		expect(Buffer.from(sql.slice(7, -10), "hex").toString()).toBe(evil);
	});

	test("parseMailboxUrl decodes paths and detects local mailboxes", () => {
		const imap = parseMailboxUrl({
			rowid: 1,
			url: "imap://UUID-1/%5BGmail%5D/Alle%20Nachrichten",
			unread: 3,
			total: 9,
		});
		expect(imap).toMatchObject({ accountId: "UUID-1", path: "[Gmail]/Alle Nachrichten", local: false });
		const local = parseMailboxUrl({ rowid: 2, url: "local://UUID-2/Drafts", unread: 0, total: 0 });
		expect(local).toMatchObject({ accountId: "UUID-2", path: "Drafts", local: true });
	});

	test("selectMailboxes filters by account and folder", () => {
		const boxes = [
			parseMailboxUrl({ rowid: 1, url: "imap://A/INBOX", unread: 0, total: 0 }),
			parseMailboxUrl({ rowid: 2, url: "imap://B/INBOX", unread: 0, total: 0 }),
			parseMailboxUrl({ rowid: 3, url: "imap://B/%5BGmail%5D/Trash", unread: 0, total: 0 }),
		];
		const accounts: MailAccount[] = [
			{ id: "A", name: "Work", emails: ["w@x.co"] },
			{ id: "B", name: "Home", emails: ["h@x.co"] },
		];
		expect(selectMailboxes(boxes, accounts, undefined, undefined).map((b) => b.rowid)).toEqual([1, 2]);
		expect(selectMailboxes(boxes, accounts, "home", "trash").map((b) => b.rowid)).toEqual([3]);
		expect(selectMailboxes(boxes, accounts, "w@x.co", "INBOX").map((b) => b.rowid)).toEqual([1]);
		expect(() => selectMailboxes(boxes, accounts, "nobody", undefined)).toThrow(/No Mail account/);
		expect(() => selectMailboxes(boxes, accounts, "work", "Nope")).toThrow(/No Mail folder/);
	});

	test("stripAngles", () => {
		expect(stripAngles("<a@b>")).toBe("a@b");
		expect(stripAngles("a@b")).toBe("a@b");
	});
});
