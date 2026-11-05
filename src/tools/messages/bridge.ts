import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { escapeAppleScriptString, OsaError, runAppleScript } from "../../lib/applescript.js";

export interface ChatSummary {
	/** Stable chat id (Messages "guid", e.g. "iMessage;-;+49…"). Usable as chatId everywhere. */
	chatId: string;
	name: string | null;
	isGroup: boolean;
	service: string | null;
	/** Participant handles (phone numbers / emails). */
	handles: string[];
	lastMessageDate: string | null;
	unreadCount: number;
}

export interface MessageItem {
	id: number;
	chatId: string;
	date: string;
	fromMe: boolean;
	/** Sender handle; null for messages sent by me. */
	sender: string | null;
	text: string;
	hasAttachments: boolean;
}

export interface ChatQuery {
	limit: number;
}

export interface ReadQuery {
	chatId?: string;
	handle?: string;
	limit: number;
	/** ISO date: only messages strictly before / after. */
	before?: string;
	after?: string;
}

export interface SearchQuery {
	query: string;
	chatId?: string;
	limit: number;
}

export interface MessageList {
	messages: MessageItem[];
	/** True when the scan cap was hit before all history was examined (search only). */
	scanLimited: boolean;
}

export type Recipient = { handle: string } | { chatId: string };

export interface MessagesBridge {
	listChats(q: ChatQuery): Promise<ChatSummary[]>;
	getChat(chatId: string): Promise<ChatSummary | null>;
	readMessages(q: ReadQuery): Promise<MessageList>;
	searchMessages(q: SearchQuery): Promise<MessageList>;
	listUnread(limit: number): Promise<MessageList>;
	sendMessage(to: Recipient, text: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

const APPLE_EPOCH_OFFSET_S = 978307200;
const MAX_TEXT = 4000;
const SEARCH_SCAN_CAP = 5000;

/**
 * Extract the message text from a hex dump of `message.attributedBody` (typedstream).
 * Layout after the "NSString" class marker: a few header bytes, 0x2b ('+'), then a length
 * (1 byte, or 0x81 + u16 LE, or 0x82 + u32 LE) and that many UTF-8 bytes.
 */
export function decodeAttributedBody(hex: string | null | undefined): string | null {
	if (!hex || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
	const buf = Buffer.from(hex, "hex");
	const marker = buf.indexOf("NSString");
	if (marker < 0) return null;
	let pos = -1;
	for (let i = marker + 8; i < Math.min(buf.length, marker + 8 + 8); i++) {
		if (buf[i] === 0x2b) {
			pos = i + 1;
			break;
		}
	}
	if (pos < 0 || pos >= buf.length) return null;
	let len = buf[pos] as number;
	pos += 1;
	if (len === 0x81) {
		if (pos + 2 > buf.length) return null;
		len = buf.readUInt16LE(pos);
		pos += 2;
	} else if (len === 0x82) {
		if (pos + 4 > buf.length) return null;
		len = buf.readUInt32LE(pos);
		pos += 4;
	}
	if (pos + len > buf.length) return null;
	return buf.toString("utf8", pos, pos + len);
}

/** Convert a raw chat.db date (ns, or older seconds, since 2001-01-01) to an ISO string. */
export function appleDateToIso(raw: number): string {
	const secs = raw > 1e12 ? raw / 1e9 : raw;
	return new Date((secs + APPLE_EPOCH_OFFSET_S) * 1000).toISOString();
}

/** Safe SQL text literal: hex blob cast to TEXT, so no quoting/escaping can be broken. */
export function sqlText(value: string): string {
	return `CAST(x'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;
}

export function sqlInt(value: number): string {
	if (!Number.isSafeInteger(value)) throw new Error(`Not an integer: ${value}`);
	return String(value);
}

export type HandleKind = { kind: "email"; value: string } | { kind: "phone"; value: string };

/** Validate a phone number or email; returns null when it is neither. */
export function parseHandle(raw: string): HandleKind | null {
	const s = raw.trim();
	if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { kind: "email", value: s };
	if (/^\+?[\d\s().-]{5,}$/.test(s)) {
		const digits = s.replace(/\D/g, "");
		if (digits.length >= 5) return { kind: "phone", value: (s.startsWith("+") ? "+" : "") + digits };
	}
	return null;
}

function isoToAppleSecs(iso: string): number {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) throw new Error(`Invalid date: ${iso}`);
	return Math.floor(t / 1000) - APPLE_EPOCH_OFFSET_S;
}

/** Seconds-since-2001 expression handling both ns and legacy second rows. */
const MSG_SECS = "(CASE WHEN m.date > 1000000000000 THEN m.date / 1000000000 ELSE m.date END)";
/** Real messages only: no tapbacks / reactions, no group-rename style events. */
const REAL_MSG =
	"m.item_type = 0 AND (m.associated_message_type IS NULL OR " +
	"m.associated_message_type NOT BETWEEN 2000 AND 3999)";

function handleCondition(h: HandleKind): string {
	if (h.kind === "email") return `lower(h.id) = lower(${sqlText(h.value)})`;
	const digits = h.value.replace(/\D/g, "");
	const tail = digits.slice(-9); // tolerate missing country code; digits only, so safe
	return `(h.id = ${sqlText(h.value)} OR REPLACE(REPLACE(h.id,'+',''),' ','') LIKE '%${tail}')`;
}

export function buildMessagesSql(opts: {
	chatId?: string;
	handle?: HandleKind;
	before?: string;
	after?: string;
	unreadOnly?: boolean;
	limit: number;
}): string {
	const where: string[] = [REAL_MSG];
	if (opts.chatId !== undefined) where.push(`c.guid = ${sqlText(opts.chatId)}`);
	if (opts.handle) {
		where.push(
			"c.style = 45 AND c.ROWID IN (SELECT chj.chat_id FROM chat_handle_join chj " +
				`JOIN handle h ON h.ROWID = chj.handle_id WHERE ${handleCondition(opts.handle)})`,
		);
	}
	if (opts.before) where.push(`${MSG_SECS} < ${sqlInt(isoToAppleSecs(opts.before))}`);
	if (opts.after) where.push(`${MSG_SECS} > ${sqlInt(isoToAppleSecs(opts.after))}`);
	if (opts.unreadOnly) where.push("m.is_from_me = 0 AND m.is_read = 0");
	return (
		"SELECT m.ROWID AS id, c.guid AS chatId, m.date AS date, m.is_from_me AS fromMe, " +
		"h2.id AS sender, m.text AS text, " +
		"CASE WHEN m.text IS NULL THEN hex(m.attributedBody) END AS body, " +
		"m.cache_has_attachments AS att " +
		"FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID " +
		"JOIN chat c ON c.ROWID = cmj.chat_id LEFT JOIN handle h2 ON h2.ROWID = m.handle_id " +
		`WHERE ${where.join(" AND ")} ORDER BY m.date DESC, m.ROWID DESC LIMIT ${sqlInt(opts.limit)}`
	);
}

const CHAT_SELECT =
	"SELECT c.guid AS chatId, c.display_name AS name, c.style AS style, " +
	"c.service_name AS service, c.chat_identifier AS ident, " +
	"(SELECT group_concat(h.id, ',') FROM chat_handle_join chj " +
	"JOIN handle h ON h.ROWID = chj.handle_id WHERE chj.chat_id = c.ROWID) AS handles, " +
	`MAX(${MSG_SECS}) AS lastSecs, ` +
	"SUM(CASE WHEN m.is_from_me = 0 AND m.is_read = 0 AND " +
	`${REAL_MSG} THEN 1 ELSE 0 END) AS unread ` +
	"FROM chat c JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID " +
	"JOIN message m ON m.ROWID = cmj.message_id ";

export function buildChatsSql(opts: { chatId?: string; limit: number }): string {
	const where = opts.chatId !== undefined ? `WHERE c.guid = ${sqlText(opts.chatId)} ` : "";
	return `${CHAT_SELECT}${where}GROUP BY c.ROWID ORDER BY lastSecs DESC LIMIT ${sqlInt(opts.limit)}`;
}

interface ChatRow {
	chatId: string;
	name: string | null;
	style: number;
	service: string | null;
	ident: string | null;
	handles: string | null;
	lastSecs: number | null;
	unread: number | null;
}

interface MessageRow {
	id: number;
	chatId: string;
	date: number;
	fromMe: number;
	sender: string | null;
	text: string | null;
	body: string | null;
	att: number;
}

export function mapChatRow(r: ChatRow): ChatSummary {
	const handles = r.handles ? r.handles.split(",") : r.ident ? [r.ident] : [];
	return {
		chatId: r.chatId,
		name: r.name ? r.name : null,
		isGroup: r.style === 43,
		service: r.service,
		handles,
		lastMessageDate: r.lastSecs === null ? null : appleDateToIso(r.lastSecs),
		unreadCount: r.unread ?? 0,
	};
}

export function mapMessageRow(r: MessageRow): MessageItem | null {
	let text = r.text ?? decodeAttributedBody(r.body) ?? "";
	text = text.replace(/￼/g, "[attachment]").trim();
	const hasAttachments = r.att === 1;
	if (!text && !hasAttachments) return null; // empty system/placeholder row
	if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}… [truncated]`;
	return {
		id: r.id,
		chatId: r.chatId,
		date: appleDateToIso(r.date),
		fromMe: r.fromMe === 1,
		sender: r.fromMe === 1 ? null : r.sender,
		text: text || "[attachment]",
		hasAttachments,
	};
}

// ---------------------------------------------------------------------------
// Real implementation
// ---------------------------------------------------------------------------

function dbUri(): string {
	const path = join(homedir(), "Library", "Messages", "chat.db");
	return `file:${path.split("/").map(encodeURIComponent).join("/")}?mode=ro`;
}

const FDA_MSG =
	"Cannot read ~/Library/Messages/chat.db. Grant Full Disk Access to the app running this " +
	"server (Terminal, Claude, …) in System Settings > Privacy & Security > Full Disk " +
	"Access, then restart that app.";

/**
 * Run a query with the sqlite3 CLI, read-only. Values are never interpolated raw: strings
 * go in as hex blob literals (sqlText) and integers are validated (sqlInt).
 */
function query<T>(sql: string): Promise<T[]> {
	return new Promise((resolve, reject) => {
		execFile(
			"sqlite3",
			["-readonly", "-json", dbUri(), sql],
			{ timeout: 15_000, maxBuffer: 64 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) {
					const msg = String(stderr || error.message);
					if (error.killed) {
						reject(new OsaError("Timed out reading the Messages database.", "timeout"));
					} else if (/unable to open|authorization denied|not permitted|disk I\/O/i.test(msg)) {
						reject(new OsaError(FDA_MSG, "permission"));
					} else {
						reject(new OsaError(`Messages database error: ${msg.trim()}`, "script"));
					}
					return;
				}
				const out = stdout.trim();
				try {
					resolve(out ? (JSON.parse(out) as T[]) : []);
				} catch {
					reject(new OsaError("Unexpected sqlite3 output.", "script"));
				}
			},
		);
	});
}

function toList(rows: MessageRow[], limit: number, scanLimited: boolean): MessageList {
	const messages: MessageItem[] = [];
	for (const r of rows) {
		const m = mapMessageRow(r);
		if (m) messages.push(m);
		if (messages.length >= limit) break;
	}
	return { messages, scanLimited };
}

export const messagesBridge: MessagesBridge = {
	async listChats({ limit }) {
		return (await query<ChatRow>(buildChatsSql({ limit }))).map(mapChatRow);
	},

	async getChat(chatId) {
		const rows = await query<ChatRow>(buildChatsSql({ chatId, limit: 1 }));
		return rows[0] ? mapChatRow(rows[0]) : null;
	},

	async readMessages(q) {
		let handle: HandleKind | undefined;
		if (q.handle !== undefined) {
			const parsed = parseHandle(q.handle);
			if (!parsed) throw new Error("handle must be a phone number or an email address.");
			handle = parsed;
		}
		const sql = buildMessagesSql({
			...(q.chatId !== undefined && { chatId: q.chatId }),
			...(handle && { handle }),
			...(q.before !== undefined && { before: q.before }),
			...(q.after !== undefined && { after: q.after }),
			limit: q.limit * 2 + 10, // slack for rows dropped as empty
		});
		const rows = await query<MessageRow>(sql);
		return toList(rows, q.limit, false);
	},

	async searchMessages(q) {
		const sql = buildMessagesSql({
			...(q.chatId !== undefined && { chatId: q.chatId }),
			limit: SEARCH_SCAN_CAP,
		});
		const rows = await query<MessageRow>(sql);
		// attributedBody-only rows can't be matched in SQL, so decode and filter here.
		const needle = q.query.toLowerCase();
		const hits: MessageItem[] = [];
		for (const r of rows) {
			const m = mapMessageRow(r);
			if (m && m.text.toLowerCase().includes(needle)) hits.push(m);
			if (hits.length >= q.limit) break;
		}
		return { messages: hits, scanLimited: rows.length >= SEARCH_SCAN_CAP && hits.length < q.limit };
	},

	async listUnread(limit) {
		const rows = await query<MessageRow>(
			buildMessagesSql({ unreadOnly: true, limit: limit * 2 + 10 }),
		);
		return toList(rows, limit, false);
	},

	async sendMessage(to, text) {
		const body = escapeAppleScriptString(text);
		const script =
			"tell application \"Messages\"\n" +
			("chatId" in to
				? `\tsend "${body}" to chat id "${escapeAppleScriptString(to.chatId)}"\n`
				: "\tset svc to 1st account whose service type = iMessage\n" +
					`\tsend "${body}" to participant "${escapeAppleScriptString(to.handle)}" of svc\n`) +
			"end tell";
		await runAppleScript(script, { app: "Messages", timeoutMs: 20_000 });
	},
};
