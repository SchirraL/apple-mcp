import { readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { OsaError, runJxa } from "../../lib/applescript.js";

// Mail's scripting dictionary is pathologically slow on big mailboxes (listing the newest 20
// messages of a 25k-message inbox took ~40s via batched JXA property reads). So:
//   - metadata (list / search / folders / locating a message) is read straight from the
//     Mail index `~/Library/Mail/V10/MailData/Envelope Index` with the sqlite3 CLI,
//     read-only (~10ms). Needs Full Disk Access for the host process.
//   - bodies and ALL writes go through the Mail scripting dictionary (JXA), addressed by
//     account id + mailbox + message `id`, which is fast (~0.3s) when the message is known.
//
// Message ids exposed to clients are the RFC Message-ID header (without angle brackets).
// Mail's own `id` is per mailbox and changes when a message moves; the header does not.
// If the same header exists in several mailboxes (Gmail copies) the first live copy wins.

// Mail bumps the V<n> directory with major macOS releases — use the newest one present.
function findMailDb(): string {
	const root = join(homedir(), "Library/Mail");
	let versions: number[] = [];
	try {
		versions = readdirSync(root)
			.map((d) => /^V(\d+)$/.exec(d)?.[1])
			.filter((v): v is string => v !== undefined)
			.map(Number);
	} catch {
		// No access (Full Disk Access missing) — fall through to the default for the error.
	}
	const v = versions.length ? Math.max(...versions) : 10;
	return join(root, `V${v}`, "MailData/Envelope Index");
}

const MAIL_DB = findMailDb();
const SQLITE_TIMEOUT_MS = 10_000;
const SNIPPET_LEN = 200;

export interface MailAccount {
	id: string;
	name: string;
	emails: string[];
}

export interface MailFolder {
	account: string;
	/** Full mailbox path, e.g. "INBOX" or "[Gmail]/Trash". */
	path: string;
	unread: number;
	total: number;
}

export interface EmailSummary {
	/** Stable id (Message-ID header). Survives moves between folders. */
	id: string;
	subject: string;
	from: string;
	/** ISO 8601, date received. */
	date: string;
	read: boolean;
	flagged: boolean;
	account: string;
	folder: string;
	snippet: string;
}

export interface Email extends EmailSummary {
	to: string[];
	cc: string[];
	/** Full plain-text body. */
	body: string;
	attachments: string[];
}

export interface EmailListQuery {
	account?: string;
	folder?: string;
	unreadOnly: boolean;
	limit: number;
}

export interface EmailSearchQuery extends EmailListQuery {
	query?: string;
	/** ISO date/time, inclusive. */
	since?: string;
	/** ISO date/time, exclusive. */
	before?: string;
}

export interface NewEmail {
	to: string[];
	cc?: string[];
	bcc?: string[];
	subject: string;
	body: string;
	/** Sender account email address; Mail's default account when omitted. */
	from?: string;
}

export interface ReplyOptions {
	body: string;
	replyAll: boolean;
	send: boolean;
}

export interface MoveTarget {
	/** Account id (Mail's UUID). */
	account: string;
	accountName: string;
	/** Resolved mailbox path in the message's account (or the named account). */
	path: string;
}

export interface MailBridge {
	listAccounts(): Promise<MailAccount[]>;
	listFolders(account?: string): Promise<MailFolder[]>;
	listEmails(q: EmailListQuery): Promise<EmailSummary[]>;
	searchEmails(q: EmailSearchQuery): Promise<EmailSummary[]>;
	getEmail(id: string): Promise<Email>;
	/** Saves a draft in Drafts without opening a compose window. */
	createDraft(m: NewEmail): Promise<void>;
	sendEmail(m: NewEmail): Promise<void>;
	/** Creates a reply draft, or sends the reply when options.send is true. */
	replyEmail(id: string, o: ReplyOptions): Promise<{ sent: boolean }>;
	/** Resolves a folder name against the message's account without moving anything. */
	resolveMoveTarget(id: string, folder: string): Promise<MoveTarget>;
	moveEmail(id: string, target: MoveTarget): Promise<void>;
	setRead(id: string, read: boolean): Promise<void>;
	setFlagged(id: string, flagged: boolean): Promise<void>;
}

// ---------------------------------------------------------------- SQLite (read-only)

/** Safe SQL text literal: user data never appears in SQL source, only as hex. */
export function sqlText(s: string): string {
	return `CAST(x'${Buffer.from(s, "utf8").toString("hex")}' AS TEXT)`;
}

function sqlInt(n: number): string {
	if (!Number.isInteger(n)) throw new Error(`Not an integer: ${n}`);
	return String(n);
}

function sqlite<R>(sql: string): Promise<R[]> {
	return new Promise((resolve, reject) => {
		execFile(
			"sqlite3",
			["-readonly", "-json", "-cmd", ".timeout 3000", MAIL_DB, sql],
			{ timeout: SQLITE_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) {
					const msg = String(stderr || error.message);
					if (/unable to open|authorization denied|not permitted/i.test(msg)) {
						reject(
							new OsaError(
								"Cannot read the Mail index. Grant Full Disk Access to the app running " +
									"this server in System Settings > Privacy & Security > Full Disk Access, " +
									"and make sure Mail is set up.",
								"permission",
							),
						);
					} else if (error.killed) {
						reject(new OsaError("Timed out reading the Mail index.", "timeout"));
					} else {
						reject(new OsaError(`Mail index query failed: ${msg.trim()}`, "script"));
					}
					return;
				}
				const out = stdout.trim();
				resolve(out === "" ? [] : (JSON.parse(out) as R[]));
			},
		);
	});
}

interface MailboxRow {
	rowid: number;
	url: string;
	unread: number;
	total: number;
}

export interface ParsedMailbox {
	rowid: number;
	accountId: string;
	path: string;
	unread: number;
	total: number;
	local: boolean;
}

export function parseMailboxUrl(row: MailboxRow): ParsedMailbox {
	const m = /^([a-z]+):\/\/([^/]*)\/?(.*)$/i.exec(row.url);
	const scheme = m?.[1] ?? "";
	const host = (m?.[2] ?? "").replace(/^.*@/, "");
	let path = m?.[3] ?? row.url;
	try {
		path = decodeURIComponent(path);
	} catch {
		// keep raw path
	}
	return {
		rowid: row.rowid,
		accountId: host,
		path,
		unread: row.unread,
		total: row.total,
		local: scheme === "local",
	};
}

async function readMailboxes(): Promise<ParsedMailbox[]> {
	const rows = await sqlite<MailboxRow>(
		"SELECT ROWID AS rowid, url, unread_count AS unread, total_count AS total FROM mailboxes",
	);
	return rows.map(parseMailboxUrl);
}

interface MessageRow {
	rowid: number;
	received: number;
	read: number;
	flagged: number;
	subject: string;
	addr: string | null;
	name: string | null;
	snippet: string | null;
	hdr: string;
	url: string;
}

const MESSAGE_SELECT = `
SELECT m.ROWID AS rowid, m.date_received AS received, m.read AS read, m.flagged AS flagged,
	COALESCE(m.subject_prefix, '') || s.subject AS subject,
	a.address AS addr, a.comment AS name, sm.summary AS snippet,
	g.message_id_header AS hdr, mb.url AS url
FROM messages m
JOIN subjects s ON s.ROWID = m.subject
JOIN message_global_data g ON g.ROWID = m.global_message_id
JOIN mailboxes mb ON mb.ROWID = m.mailbox
LEFT JOIN addresses a ON a.ROWID = m.sender
LEFT JOIN summaries sm ON sm.ROWID = m.summary`;

export function stripAngles(h: string): string {
	return h.replace(/^<(.*)>$/s, "$1");
}

function formatSender(addr: string | null, name: string | null): string {
	if (!addr) return name ?? "";
	return name && name !== addr ? `${name} <${addr}>` : addr;
}

function toSummary(r: MessageRow, accounts: Map<string, string>): EmailSummary {
	const box = parseMailboxUrl({ rowid: 0, url: r.url, unread: 0, total: 0 });
	const hdr = stripAngles(r.hdr ?? "");
	return {
		id: hdr !== "" ? hdr : `rowid:${r.rowid}`,
		subject: r.subject ?? "",
		from: formatSender(r.addr, r.name),
		date: new Date(r.received * 1000).toISOString(),
		read: r.read === 1,
		flagged: r.flagged === 1,
		account: accounts.get(box.accountId) ?? (box.local ? "On My Mac" : box.accountId),
		folder: box.path,
		snippet: (r.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, SNIPPET_LEN),
	};
}

// Account names live only in Mail's scripting layer; cache them briefly.
let accountCache: { at: number; accounts: MailAccount[] } | null = null;

async function fetchAccounts(): Promise<MailAccount[]> {
	if (accountCache && Date.now() - accountCache.at < 60_000) return accountCache.accounts;
	const accounts = await runJxa(
		() => {
			const app = Application("Mail");
			return app.accounts().map((a: any) => ({
				id: String(a.id()),
				name: String(a.name()),
				emails: (a.emailAddresses() as string[]).map(String),
			}));
		},
		null,
		{ app: "Mail" },
	);
	accountCache = { at: Date.now(), accounts };
	return accounts;
}

async function accountNames(): Promise<Map<string, string>> {
	return new Map((await fetchAccounts()).map((a) => [a.id, a.name]));
}

/** Restrict mailboxes to an account given by name, id or email address. */
export function filterAccount(
	boxes: ParsedMailbox[],
	accounts: MailAccount[],
	account: string | undefined,
): ParsedMailbox[] {
	let out = boxes;
	if (account !== undefined) {
		const want = account.toLowerCase();
		// listFolders reports local mailboxes under this pseudo-account; accept it back.
		if (want === "on my mac") return out.filter((b) => b.local);
		const ids = new Set(
			accounts
				.filter(
					(a) =>
						a.id.toLowerCase() === want ||
						a.name.toLowerCase() === want ||
						a.emails.some((e) => e.toLowerCase() === want),
				)
				.map((a) => a.id),
		);
		if (ids.size === 0) {
			throw new Error(
				`No Mail account "${account}". Accounts: ${accounts.map((a) => a.name).join(", ")}`,
			);
		}
		out = out.filter((b) => ids.has(b.accountId));
	}
	return out;
}

/** Pick mailboxes by optional account (name, id or email) and folder (path or last segment). */
export function selectMailboxes(
	boxes: ParsedMailbox[],
	accounts: MailAccount[],
	account: string | undefined,
	folder: string | undefined,
): ParsedMailbox[] {
	const out = filterAccount(boxes, accounts, account);
	const f = (folder ?? "INBOX").toLowerCase();
	const hits = out.filter((b) => {
		const p = b.path.toLowerCase();
		return p === f || p.split("/").pop() === f;
	});
	if (hits.length === 0) {
		const names = [...new Set(out.map((b) => b.path))].join(", ");
		throw new Error(`No Mail folder "${folder ?? "INBOX"}". Folders: ${names}`);
	}
	return hits;
}

function inMailboxes(ids: number[]): string {
	const list = ids.map(sqlInt).join(",");
	return `(m.mailbox IN (${list}) OR m.ROWID IN (SELECT message_id FROM labels WHERE mailbox_id IN (${list})))`;
}

async function queryEmails(q: EmailSearchQuery): Promise<EmailSummary[]> {
	const [boxes, accounts] = await Promise.all([readMailboxes(), fetchAccounts()]);
	const names = new Map(accounts.map((a) => [a.id, a.name]));
	const ids = selectMailboxes(boxes, accounts, q.account, q.folder).map((b) => b.rowid);
	const where = ["m.deleted = 0", inMailboxes(ids)];
	if (q.unreadOnly) where.push("m.read = 0");
	if (q.since) where.push(`m.date_received >= ${sqlInt(Math.floor(Date.parse(q.since) / 1000))}`);
	if (q.before) where.push(`m.date_received < ${sqlInt(Math.floor(Date.parse(q.before) / 1000))}`);
	for (const term of (q.query ?? "").split(/\s+/).filter(Boolean)) {
		const t = sqlText(term.toLowerCase());
		where.push(
			"(" +
				[
					"COALESCE(m.subject_prefix,'') || s.subject",
					"COALESCE(a.address,'')",
					"COALESCE(a.comment,'')",
					"COALESCE(sm.summary,'')",
				]
					.map((c) => `instr(lower(${c}), ${t}) > 0`)
					.join(" OR ") +
				")",
		);
	}
	const sql = `${MESSAGE_SELECT} WHERE ${where.join(" AND ")} ORDER BY m.date_received DESC LIMIT ${sqlInt(q.limit)}`;
	const rows = await sqlite<MessageRow>(sql);
	const seen = new Set<string>();
	const out: EmailSummary[] = [];
	for (const r of rows) {
		const s = toSummary(r, names);
		if (seen.has(s.id)) continue;
		seen.add(s.id);
		out.push(s);
	}
	return out;
}

interface Located {
	rowid: number;
	/** null for local ("On My Mac") mailboxes. */
	accountId: string | null;
	path: string;
}

async function locate(id: string): Promise<Located> {
	let where: string;
	const rowMatch = /^rowid:(\d+)$/.exec(id);
	if (rowMatch) {
		where = `m.ROWID = ${sqlInt(Number(rowMatch[1]))}`;
	} else {
		const t = sqlText(id);
		where = `g.message_id_header IN (${t}, '<' || ${t} || '>')`;
	}
	const rows = await sqlite<{ rowid: number; url: string }>(
		`SELECT m.ROWID AS rowid, mb.url AS url FROM messages m
		JOIN message_global_data g ON g.ROWID = m.global_message_id
		JOIN mailboxes mb ON mb.ROWID = m.mailbox
		WHERE ${where} AND m.deleted = 0 ORDER BY m.ROWID DESC LIMIT 1`,
	);
	const row = rows[0];
	if (!row) throw new Error(`No email with id ${id}. Ids come from list_emails/search_emails.`);
	const box = parseMailboxUrl({ rowid: 0, url: row.url, unread: 0, total: 0 });
	return { rowid: row.rowid, accountId: box.local ? null : box.accountId, path: box.path };
}

// ---------------------------------------------------------------- JXA (bodies + writes)

type MailOp =
	| { op: "read"; loc: Located }
	| { op: "mark"; loc: Located; field: "read" | "flagged"; value: boolean }
	| { op: "target"; loc: Located; folder: string }
	| { op: "move"; loc: Located; target: MoveTarget }
	| { op: "compose"; m: NewEmail; send: boolean }
	| { op: "reply"; loc: Located; o: ReplyOptions };

/**
 * Runs inside osascript (JXA). Must stay fully self-contained: no imports, no outer refs.
 */
function mailScript(a: MailOp): unknown {
	const app = Application("Mail");

	const mailboxes = (accountId: string | null) =>
		accountId === null ? app.mailboxes : app.accounts.byId(accountId).mailboxes;

	const find = (loc: { rowid: number; accountId: string | null; path: string }) => {
		const m = mailboxes(loc.accountId).byName(loc.path).messages.byId(loc.rowid);
		try {
			m.messageId();
		} catch (e) {
			throw new Error("The email is no longer available in Mail (moved or deleted?)");
		}
		return m;
	};

	const fmt = (name: string, address: string) =>
		name && name !== address ? `${name} <${address}>` : address;

	const recipients = (list: any): string[] => {
		const names: string[] = list.name();
		const addrs: string[] = list.address();
		return addrs.map((ad, i) => fmt(String(names[i] ?? ""), String(ad)));
	};

	const addRecipients = (msg: any, m: any) => {
		for (const address of m.to) msg.toRecipients.push(app.ToRecipient({ address }));
		for (const address of m.cc ?? []) msg.ccRecipients.push(app.CcRecipient({ address }));
		for (const address of m.bcc ?? []) msg.bccRecipients.push(app.BccRecipient({ address }));
	};

	switch (a.op) {
		case "read": {
			const m = find(a.loc);
			return {
				to: recipients(m.toRecipients),
				cc: recipients(m.ccRecipients),
				body: String(m.content()),
				attachments: m.mailAttachments.name() as string[],
			};
		}
		case "mark": {
			const m = find(a.loc);
			if (a.field === "read") m.readStatus = a.value;
			else m.flaggedStatus = a.value;
			return null;
		}
		case "target": {
			// "Account/Folder" targets another account; a bare name stays in the message's.
			const m = a.loc.accountId === null ? null : app.accounts.byId(a.loc.accountId);
			const accounts: any[] = app.accounts();
			let acc = m;
			let folder = a.folder;
			const slash = a.folder.indexOf("/");
			if (slash > 0) {
				const maybe = accounts.find(
					(x) => String(x.name()).toLowerCase() === a.folder.slice(0, slash).toLowerCase(),
				);
				if (maybe) {
					acc = maybe;
					folder = a.folder.slice(slash + 1);
				}
			}
			if (!acc) throw new Error("Cannot move local messages with this tool");
			const names: string[] = acc.mailboxes.name();
			const want = folder.toLowerCase();
			let hits = names.filter((n) => n.toLowerCase() === want);
			if (hits.length === 0) {
				hits = names.filter((n) => (n.split("/").pop() ?? "").toLowerCase() === want);
			}
			if (hits.length !== 1) {
				throw new Error(
					(hits.length === 0 ? `No folder "${folder}"` : `Folder "${folder}" is ambiguous`) +
						` in account "${acc.name()}". Folders: ${names.join(", ")}`,
				);
			}
			return { account: String(acc.id()), accountName: String(acc.name()), path: hits[0] };
		}
		case "move": {
			const m = find(a.loc);
			const dest = mailboxes(a.target.account).byName(a.target.path);
			app.move(m, { to: dest });
			return null;
		}
		case "compose": {
			const props: any = { subject: a.m.subject, content: a.m.body, visible: false };
			if (a.m.from) props.sender = a.m.from;
			const msg = app.OutgoingMessage(props);
			app.outgoingMessages.push(msg);
			addRecipients(msg, a.m);
			if (a.send) msg.send();
			else msg.save();
			return null;
		}
		case "reply": {
			const m = find(a.loc);
			const r = app.reply(m, { openingWindow: false, replyToAll: a.o.replyAll });
			r.content = a.o.body + "\n\n" + String(r.content());
			if (a.o.send) r.send();
			else r.save();
			return { sent: a.o.send };
		}
	}
}

const run = <R>(op: MailOp): Promise<R> =>
	runJxa(mailScript, op, { app: "Mail", timeoutMs: 30_000 }) as Promise<R>;

export const mailBridge: MailBridge = {
	listAccounts: fetchAccounts,

	async listFolders(account) {
		const [boxes, accounts] = await Promise.all([readMailboxes(), fetchAccounts()]);
		const names = new Map(accounts.map((a) => [a.id, a.name]));
		const scope = filterAccount(boxes, accounts, account);
		return scope
			.map((b) => ({
				account: names.get(b.accountId) ?? (b.local ? "On My Mac" : b.accountId),
				path: b.path,
				unread: b.unread,
				total: b.total,
			}))
			.sort((x, y) => x.account.localeCompare(y.account) || x.path.localeCompare(y.path));
	},

	listEmails: (q) => queryEmails(q),
	searchEmails: (q) => queryEmails(q),

	async getEmail(id) {
		const loc = await locate(id);
		const [rows, body, names] = await Promise.all([
			sqlite<MessageRow>(`${MESSAGE_SELECT} WHERE m.ROWID = ${sqlInt(loc.rowid)}`),
			run<{ to: string[]; cc: string[]; body: string; attachments: string[] }>({
				op: "read",
				loc,
			}),
			accountNames(),
		]);
		const row = rows[0];
		if (!row) throw new Error(`No email with id ${id}`);
		return { ...toSummary(row, names), id, ...body };
	},

	createDraft: (m) => run<null>({ op: "compose", m, send: false }).then(() => undefined),
	sendEmail: (m) => run<null>({ op: "compose", m, send: true }).then(() => undefined),
	async replyEmail(id, o) {
		return run({ op: "reply", loc: await locate(id), o });
	},
	async resolveMoveTarget(id, folder) {
		return run({ op: "target", loc: await locate(id), folder });
	},
	async moveEmail(id, target) {
		await run<null>({ op: "move", loc: await locate(id), target });
	},
	async setRead(id, read) {
		await run<null>({ op: "mark", loc: await locate(id), field: "read", value: read });
	},
	async setFlagged(id, flagged) {
		await run<null>({ op: "mark", loc: await locate(id), field: "flagged", value: flagged });
	},
};
