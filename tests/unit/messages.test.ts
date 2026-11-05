import { beforeEach, describe, expect, test } from "bun:test";
import type { ToolModule } from "../../src/lib/types.js";
import {
	appleDateToIso,
	buildMessagesSql,
	type ChatQuery,
	type ChatSummary,
	decodeAttributedBody,
	type MessageItem,
	type MessageList,
	type MessagesBridge,
	mapMessageRow,
	parseHandle,
	type ReadQuery,
	type Recipient,
	type SearchQuery,
	sqlText,
} from "../../src/tools/messages/bridge.js";
import { createMessagesModule } from "../../src/tools/messages/handler.js";

const chat: ChatSummary = {
	chatId: "iMessage;-;+4915112345678",
	name: null,
	isGroup: false,
	service: "iMessage",
	handles: ["+4915112345678"],
	lastMessageDate: "2026-11-05T10:00:00.000Z",
	unreadCount: 2,
};
const msg: MessageItem = {
	id: 1,
	chatId: chat.chatId,
	date: "2026-11-05T10:00:00.000Z",
	fromMe: false,
	sender: "+4915112345678",
	text: "hi",
	hasAttachments: false,
};

class FakeBridge implements MessagesBridge {
	calls: { method: string; args: unknown[] }[] = [];
	error: Error | null = null;
	chatExists = true;

	private record(method: string, ...args: unknown[]): void {
		this.calls.push({ method, args });
		if (this.error) throw this.error;
	}
	callsOf(method: string): unknown[][] {
		return this.calls.filter((c) => c.method === method).map((c) => c.args);
	}
	async listChats(q: ChatQuery): Promise<ChatSummary[]> {
		this.record("listChats", q);
		return [chat];
	}
	async getChat(id: string): Promise<ChatSummary | null> {
		this.record("getChat", id);
		return this.chatExists ? chat : null;
	}
	async readMessages(q: ReadQuery): Promise<MessageList> {
		this.record("readMessages", q);
		return { messages: [msg], scanLimited: false };
	}
	async searchMessages(q: SearchQuery): Promise<MessageList> {
		this.record("searchMessages", q);
		return { messages: [msg], scanLimited: true };
	}
	async listUnread(limit: number): Promise<MessageList> {
		this.record("listUnread", limit);
		return { messages: [msg], scanLimited: false };
	}
	async sendMessage(to: Recipient, text: string): Promise<void> {
		this.record("sendMessage", to, text);
	}
}

function textOf(r: { content: { type: string; text?: string }[] }): string {
	return r.content.map((c) => c.text ?? "").join("\n");
}

describe("decodeAttributedBody", () => {
	const hexStr = (s: string): string => Buffer.from(s, "utf8").toString("hex");
	const head = `${hexStr("streamtyped")}8101${hexStr("NSAttributedString")}`;
	const nsstring = `${hexStr("NSString")}01948401`;

	test("short length prefix", () => {
		const blob = `${head}${nsstring}2b${(5).toString(16).padStart(2, "0")}${hexStr("Hello")}868402`;
		expect(decodeAttributedBody(blob)).toBe("Hello");
	});

	test("0x81 u16 length and UTF-8", () => {
		const text = `Grüße 👋 ${"x".repeat(200)}`;
		const bytes = Buffer.from(text, "utf8");
		const len = Buffer.alloc(2);
		len.writeUInt16LE(bytes.length);
		const blob = `${head}${nsstring}2b81${len.toString("hex")}${bytes.toString("hex")}8684`;
		expect(decodeAttributedBody(blob)).toBe(text);
	});

	test("returns null for garbage, missing marker, truncated data", () => {
		expect(decodeAttributedBody(null)).toBeNull();
		expect(decodeAttributedBody("zz")).toBeNull();
		expect(decodeAttributedBody(hexStr("no marker here"))).toBeNull();
		expect(decodeAttributedBody(`${head}${nsstring}2b10${hexStr("ab")}`)).toBeNull();
	});
});

describe("helpers", () => {
	test("dates: nanoseconds and legacy seconds", () => {
		expect(appleDateToIso(0)).toBe("2001-01-01T00:00:00.000Z");
		expect(appleDateToIso(86400 * 1e9)).toBe("2001-01-02T00:00:00.000Z");
		expect(appleDateToIso(86400)).toBe("2001-01-02T00:00:00.000Z");
	});

	test("parseHandle", () => {
		expect(parseHandle("+49 151 1234-5678")).toEqual({ kind: "phone", value: "+4915112345678" });
		expect(parseHandle("a@b.de")).toEqual({ kind: "email", value: "a@b.de" });
		expect(parseHandle("x'; DROP TABLE message;--")).toBeNull();
		expect(parseHandle("12")).toBeNull();
	});

	test("string params never appear raw in SQL", () => {
		const evil = "x'; DROP TABLE message;--";
		const sql = buildMessagesSql({ chatId: evil, limit: 5 });
		expect(sql).not.toContain("DROP");
		expect(sql).toContain(sqlText(evil));
		expect(() => buildMessagesSql({ limit: 1.5 })).toThrow();
		expect(() => buildMessagesSql({ limit: 5, before: "not a date" })).toThrow();
	});

	test("mapMessageRow uses attributedBody fallback and skips empty rows", () => {
		const hex = Buffer.from("NSString\x01\x94\x84\x01+\x02ok", "latin1").toString("hex");
		const base = { id: 1, chatId: "c", date: 0, fromMe: 1, sender: "s", att: 0 };
		const m = mapMessageRow({ ...base, text: null, body: hex });
		expect(m?.text).toBe("ok");
		expect(m?.sender).toBeNull();
		expect(m?.fromMe).toBe(true);
		expect(mapMessageRow({ ...base, text: null, body: null })).toBeNull();
		expect(mapMessageRow({ ...base, text: "￼", body: null, att: 1 })?.text).toBe(
			"[attachment]",
		);
	});
});

describe("messages module", () => {
	let bridge: FakeBridge;
	let mod: ToolModule;

	beforeEach(() => {
		bridge = new FakeBridge();
		mod = createMessagesModule(bridge);
	});

	test("registers the expected tools", () => {
		expect(mod.tools.map((t) => t.name)).toEqual([
			"list_message_chats",
			"read_messages",
			"search_messages",
			"list_unread_messages",
			"send_message",
		]);
	});

	test("list_message_chats applies the default limit", async () => {
		const r = await mod.handle("list_message_chats", {});
		expect(r.isError).toBeFalsy();
		expect(bridge.callsOf("listChats")[0]).toEqual([{ limit: 20 }]);
	});

	test("read_messages needs exactly one of chatId / handle", async () => {
		expect((await mod.handle("read_messages", {})).isError).toBe(true);
		expect((await mod.handle("read_messages", { chatId: "a", handle: "b@c.de" })).isError).toBe(
			true,
		);
		expect((await mod.handle("read_messages", { handle: "garbage" })).isError).toBe(true);
		expect((await mod.handle("read_messages", { chatId: "a", before: "nope" })).isError).toBe(true);
		const ok = await mod.handle("read_messages", { handle: "+49 151 1", limit: 3 });
		expect(ok.isError).toBeFalsy();
		expect(bridge.callsOf("readMessages")[0]).toEqual([{ handle: "+49 151 1", limit: 3 }]);
	});

	test("search_messages passes query and mentions scan cap", async () => {
		const r = await mod.handle("search_messages", { query: "  lunch ", chatId: "c1" });
		expect(bridge.callsOf("searchMessages")[0]).toEqual([
			{ query: "lunch", chatId: "c1", limit: 20 },
		]);
		expect(textOf(r)).toContain("5000");
		expect((await mod.handle("search_messages", { query: " " })).isError).toBe(true);
	});

	test("list_unread_messages", async () => {
		await mod.handle("list_unread_messages", { limit: 5 });
		expect(bridge.callsOf("listUnread")[0]).toEqual([5]);
	});

	test("send_message without confirm previews and sends nothing", async () => {
		const r = await mod.handle("send_message", { to: "+49 151 1234567", text: "Hello\nthere" });
		const t = textOf(r);
		expect(t).toContain("PREVIEW");
		expect(t).toContain("+491511234567");
		expect(t).toContain("Hello\nthere");
		expect(bridge.callsOf("sendMessage")).toHaveLength(0);
	});

	test("send_message with confirm:false still only previews", async () => {
		await mod.handle("send_message", { chatId: chat.chatId, text: "x", confirm: false });
		expect(bridge.callsOf("sendMessage")).toHaveLength(0);
	});

	test("send_message with confirm sends to handle", async () => {
		const r = await mod.handle("send_message", {
			to: "a@b.de",
			text: "yo",
			confirm: true,
		});
		expect(r.isError).toBeFalsy();
		expect(bridge.callsOf("sendMessage")[0]).toEqual([{ handle: "a@b.de" }, "yo"]);
	});

	test("send_message to chat id previews the chat and sends on confirm", async () => {
		const p = await mod.handle("send_message", { chatId: chat.chatId, text: "yo" });
		expect(textOf(p)).toContain("+4915112345678");
		expect(bridge.callsOf("sendMessage")).toHaveLength(0);
		await mod.handle("send_message", { chatId: chat.chatId, text: "yo", confirm: true });
		expect(bridge.callsOf("sendMessage")[0]).toEqual([{ chatId: chat.chatId }, "yo"]);
	});

	test("send_message validation and unknown chat", async () => {
		expect((await mod.handle("send_message", { text: "x", confirm: true })).isError).toBe(true);
		expect(
			(await mod.handle("send_message", { to: "a@b.de", chatId: "c", text: "x", confirm: true }))
				.isError,
		).toBe(true);
		expect((await mod.handle("send_message", { to: "nope", text: "x", confirm: true })).isError).toBe(
			true,
		);
		expect((await mod.handle("send_message", { to: "a@b.de", text: "", confirm: true })).isError).toBe(
			true,
		);
		bridge.chatExists = false;
		const r = await mod.handle("send_message", { chatId: "zzz", text: "x", confirm: true });
		expect(r.isError).toBe(true);
		expect(bridge.callsOf("sendMessage")).toHaveLength(0);
	});

	test("bridge errors surface as tool errors", async () => {
		bridge.error = new Error("Full Disk Access missing");
		const r = await mod.handle("list_message_chats", {});
		expect(r.isError).toBe(true);
		expect(textOf(r)).toContain("Full Disk Access");
	});
});
