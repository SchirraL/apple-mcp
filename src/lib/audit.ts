import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { LOG_DIR } from "./service-config.js";

export type Effect = "read" | "write" | "external";
export type AuditMode = "confirmed" | "previewed" | "direct";

export interface AuditEntry {
	ts: string;
	tool: string;
	effect: Effect;
	mode: AuditMode;
	outcome: "ok" | "error";
	error?: string;
	target: Record<string, unknown>;
	ms: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_STRING = 120;
const MAX_ITEMS = 5;
const MAX_ERROR = 200;

/** Identifier-ish keys whose values are logged (capped). Everything else is omitted. */
export const AUDIT_ALLOWLIST: ReadonlySet<string> = new Set([
	"id",
	"ids",
	"noteId",
	"eventId",
	"reminderId",
	"messageId",
	"chatId",
	"handle",
	"list",
	"listName",
	"calendar",
	"folder",
	"mailbox",
	"account",
	"path",
	"inputPath",
	"note",
	"from",
	"to",
	"cc",
	"bcc",
	"destination",
	"dir",
	"playlist",
	"vault",
	"occurrenceStart",
	"trackIds",
	"kind",
	"mode",
	"span",
	"action",
	"replyAll",
	"send",
]);

/** Content-like keys: only the length (strings) or item count (arrays) is logged. */
export const AUDIT_LENGTH_ONLY: ReadonlySet<string> = new Set([
	"body",
	"content",
	"text",
	"message",
	"subject",
	"notes",
	"html",
	"title",
	"name",
	"query",
	"description",
	"location",
	"input",
	"inputText",
	"pattern",
	"frontmatter",
	"tags",
	"emails",
	"phones",
	"urls",
	"addEmails",
	"addPhones",
	"addUrls",
	"givenName",
	"familyName",
	"nickname",
	"organization",
	"jobTitle",
	"department",
]);

function cap(s: string): string {
	return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}...` : s;
}

function scalar(v: unknown): string | number | boolean | undefined {
	if (typeof v === "string") return cap(v);
	if (typeof v === "number" || typeof v === "boolean") return v;
	return undefined;
}

function allowedValue(v: unknown): unknown {
	if (Array.isArray(v)) {
		const items = v.slice(0, MAX_ITEMS).map(scalar).filter((x) => x !== undefined);
		return v.length > MAX_ITEMS ? { items, count: v.length } : items;
	}
	return scalar(v);
}

/** Privacy-preserving summary of tool args: allowlisted identifiers, lengths of content. */
export function summarizeArgs(args: unknown): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (typeof args !== "object" || args === null) return out;
	for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
		if (v === undefined || v === null) continue;
		if (AUDIT_ALLOWLIST.has(k)) {
			const val = allowedValue(v);
			if (val !== undefined) out[k] = val;
		} else if (AUDIT_LENGTH_ONLY.has(k)) {
			if (typeof v === "string") out[`${k}Len`] = v.length;
			else if (Array.isArray(v)) out[`${k}Count`] = v.length;
		}
	}
	return out;
}

/** Cap values of a tool-provided override so it cannot leak long content. */
export function sanitizeTarget(t: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(t)) {
		const val = allowedValue(v);
		if (val !== undefined) out[k] = val;
	}
	return out;
}

export function auditLogPath(): string {
	return process.env.APPLE_MCP_AUDIT_LOG || join(LOG_DIR, "audit.jsonl");
}

function maxBytes(): number {
	const n = Number(process.env.APPLE_MCP_AUDIT_MAX_BYTES);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

/** Append one entry. Never throws: logging must not break a tool call. */
export function appendAudit(entry: AuditEntry): void {
	// Under `bun test`, never touch the real log unless a test points it elsewhere.
	if (process.env.NODE_ENV === "test" && !process.env.APPLE_MCP_AUDIT_LOG) return;
	try {
		const file = auditLogPath();
		const dir = dirname(file);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
		if (existsSync(file) && statSync(file).size >= maxBytes()) {
			renameSync(file, `${file}.1`);
		}
		if (entry.error !== undefined && entry.error.length > MAX_ERROR) {
			entry.error = `${entry.error.slice(0, MAX_ERROR)}...`;
		}
		appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
		chmodSync(file, 0o600);
	} catch (error) {
		console.error("[audit] could not write audit log:", error);
	}
}

export interface ReadAuditOptions {
	limit: number;
	tool?: string;
	since?: string;
}

/** Newest-first entries from audit.jsonl (and .1 when needed); malformed lines skipped. */
export function readAudit(opts: ReadAuditOptions): AuditEntry[] {
	const file = auditLogPath();
	const sinceMs = opts.since ? Date.parse(opts.since) : Number.NaN;
	const out: AuditEntry[] = [];
	for (const f of [file, `${file}.1`]) {
		if (out.length >= opts.limit) break;
		let text: string;
		try {
			text = readFileSync(f, "utf8");
		} catch {
			continue;
		}
		const lines = text.split("\n");
		for (let i = lines.length - 1; i >= 0 && out.length < opts.limit; i--) {
			const line = lines[i]?.trim();
			if (!line) continue;
			let e: AuditEntry;
			try {
				e = JSON.parse(line) as AuditEntry;
			} catch {
				continue;
			}
			if (typeof e !== "object" || e === null || typeof e.tool !== "string") continue;
			if (opts.tool && e.tool !== opts.tool) continue;
			if (!Number.isNaN(sinceMs) && !(Date.parse(e.ts) >= sinceMs)) continue;
			out.push(e);
		}
	}
	return out;
}
