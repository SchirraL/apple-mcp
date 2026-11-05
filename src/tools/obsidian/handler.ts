import { basename, join, sep } from "node:path";
import { z } from "zod";
import {
	expandHome,
	loadPolicy,
	type PathPolicy,
	PathPolicyError,
	resolveAllowedPath,
} from "../../lib/paths.js";
import { confirmField, withConfirm } from "../../lib/safety.js";
import {
	type CallToolResult,
	dataResult,
	defineTool,
	errorResult,
	textResult,
	type ToolModule,
	toolModule,
} from "../../lib/types.js";
import { type NoteFile, type ObsidianBridge, obsidianBridge, type VaultRecord } from "./bridge.js";

const MAX_NOTE_BYTES = 5_000_000;
const MAX_SCAN_BYTES = 1_000_000; // per-file cap when scanning content (search, backlinks)
const MAX_SCAN_FILES = 20_000;
const MAX_BACKLINK_FILES = 5_000;
const DEFAULT_BODY_CHARS = 50_000;
const OUTSIDE = "(outside allowed locations)";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export type YamlValue = string | number | boolean | null | YamlValue[];

export interface Split {
	/** Raw frontmatter text between the fences, or null if the note has none. */
	raw: string | null;
	body: string;
	/** Index in the original text where the body starts. */
	bodyStart: number;
}

export function splitFrontmatter(text: string): Split {
	const m = /^﻿?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text);
	if (!m) return { raw: null, body: text, bodyStart: 0 };
	return { raw: m[1] ?? "", body: text.slice(m[0].length), bodyStart: m[0].length };
}

function parseScalar(s: string): YamlValue {
	let v = s.trim();
	if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0] as string)) {
		return v.slice(1, -1);
	}
	v = v.replace(/\s+#.*$/, "").trim();
	if (v === "" || v === "~" || v === "null") return null;
	if (v === "true") return true;
	if (v === "false") return false;
	if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
	return v;
}

function splitInlineList(inner: string): string[] {
	const parts: string[] = [];
	let cur = "";
	let quote = "";
	for (const ch of inner) {
		if (quote) {
			cur += ch;
			if (ch === quote) quote = "";
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			cur += ch;
		} else if (ch === ",") {
			parts.push(cur);
			cur = "";
		} else cur += ch;
	}
	if (cur.trim() !== "") parts.push(cur);
	return parts;
}

/**
 * Small, safe YAML subset: `key: scalar`, `key: [a, b]` and block lists (`- item`).
 * Nested maps, block scalars (| >) and flow maps are skipped, not guessed at.
 */
export function parseFrontmatter(raw: string): Record<string, YamlValue> {
	const out: Record<string, YamlValue> = {};
	const lines = raw.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		const m = /^([^\s#:][^:]*?):(?:\s+(.*))?$/.exec(line);
		if (!m) continue;
		const key = (m[1] as string).trim().replace(/^["']|["']$/g, "");
		const rest = (m[2] ?? "").trim();
		if (key === "__proto__" || key === "constructor") continue;
		// Collect indented continuation lines (block list or nested content).
		const block: string[] = [];
		while (i + 1 < lines.length && /^(\s+\S|-\s|\s*$)/.test(lines[i + 1] as string)) {
			block.push(lines[++i] as string);
		}
		if (rest === "") {
			const items = block.filter((l) => l.trim() !== "");
			if (items.length === 0) out[key] = null;
			else if (items.every((l) => /^\s*-\s+/.test(l))) {
				out[key] = items.map((l) => parseScalar(l.replace(/^\s*-\s+/, "")));
			}
			// else: nested map, skipped
		} else if (/^[|>][+-]?$/.test(rest) || rest.startsWith("{")) {
			// block scalar / flow map: skipped
		} else if (rest.startsWith("[") && rest.endsWith("]")) {
			out[key] = splitInlineList(rest.slice(1, -1)).map(parseScalar);
		} else {
			out[key] = parseScalar(rest);
		}
	}
	return out;
}

function stripCode(text: string): string {
	return text
		.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "")
		.replace(/`[^`\n]*`/g, "");
}

export interface NoteLink {
	target: string;
	embed: boolean;
	heading?: string;
	alias?: string;
}

/** `[[Note]]`, `[[Note#Heading|alias]]` and `![[embed]]`, ignoring code. Deduplicated. */
export function extractLinks(body: string): NoteLink[] {
	const seen = new Set<string>();
	const out: NoteLink[] = [];
	const re = /(!?)\[\[([^\][|#^]+)(?:[#^]([^\][|]*))?(?:\|([^\]]*))?\]\]/g;
	for (const m of stripCode(body).matchAll(re)) {
		const link: NoteLink = { target: (m[2] as string).trim(), embed: m[1] === "!" };
		if (m[3]) link.heading = m[3].trim();
		if (m[4]) link.alias = m[4].trim();
		const key = `${link.embed}|${link.target}|${link.heading ?? ""}`;
		if (link.target && !seen.has(key)) {
			seen.add(key);
			out.push(link);
		}
	}
	return out;
}

function normTag(t: string): string {
	return t.trim().replace(/^#/, "");
}

/** Tags from `tags:`/`tag:` frontmatter and inline `#tag` in the body (no leading #). */
export function extractTags(fm: Record<string, YamlValue>, body: string): string[] {
	const tags = new Set<string>();
	for (const key of ["tags", "tag"]) {
		const v = fm[key];
		const items = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\s]+/) : [];
		for (const t of items) if (typeof t === "string" && normTag(t)) tags.add(normTag(t));
	}
	const re = /(?:^|[\s(])#([\p{L}\p{N}_/-]*\p{L}[\p{L}\p{N}_/-]*)/gu;
	for (const m of stripCode(body).matchAll(re)) tags.add(m[1] as string);
	return [...tags].sort();
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/** Subset of moment.js formatting used by Obsidian's daily notes. `[text]` is literal. */
export function formatMoment(d: Date, fmt: string): string {
	const p2 = (n: number): string => String(n).padStart(2, "0");
	const map: Record<string, string> = {
		YYYY: String(d.getFullYear()),
		YY: p2(d.getFullYear() % 100),
		MMMM: MONTHS[d.getMonth()] as string,
		MMM: (MONTHS[d.getMonth()] as string).slice(0, 3),
		MM: p2(d.getMonth() + 1),
		M: String(d.getMonth() + 1),
		DD: p2(d.getDate()),
		D: String(d.getDate()),
		dddd: DAYS[d.getDay()] as string,
		ddd: (DAYS[d.getDay()] as string).slice(0, 3),
		HH: p2(d.getHours()),
		mm: p2(d.getMinutes()),
		ss: p2(d.getSeconds()),
	};
	return fmt.replace(
		/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|mm|ss/g,
		(tok, literal: string | undefined) => (literal !== undefined ? literal : (map[tok] ?? tok)),
	);
}

/** Append `add` to `text` on its own line(s), ending with a newline. */
export function appendText(text: string, add: string): string {
	const sep = text === "" || text.endsWith("\n") ? "" : "\n";
	return `${text}${sep}${add}${add.endsWith("\n") ? "" : "\n"}`;
}

/** Insert `add` right after the frontmatter block (or at the top if there is none). */
export function prependAfterFrontmatter(text: string, add: string): string {
	const { raw, bodyStart } = splitFrontmatter(text);
	const block = add.endsWith("\n") ? add : `${add}\n`;
	if (raw === null) return block + text;
	let head = text.slice(0, bodyStart);
	if (!head.endsWith("\n")) head += "\n";
	return head + block + text.slice(bodyStart);
}

function snippetAround(text: string, idx: number, len: number): string {
	const start = Math.max(0, idx - 60);
	const end = Math.min(text.length, idx + len + 100);
	const s = text.slice(start, end).replace(/\s+/g, " ").trim();
	return `${start > 0 ? "..." : ""}${s}${end < text.length ? "..." : ""}`;
}

const titleOf = (rel: string): string => basename(rel).replace(/\.md$/i, "");
const iso = (ms: number): string => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

interface Vault {
	record: VaultRecord;
	/** Canonical absolute vault root (policy-checked). */
	root: string;
	name: string;
}

/**
 * Expected, user-facing failure (unknown vault, ambiguous note, ...). Subclasses
 * PathPolicyError so toolModule reports it without logging a stack trace.
 */
class UserError extends PathPolicyError {}

export function createObsidianModule(
	bridge: ObsidianBridge = obsidianBridge,
	policyOverride?: PathPolicy,
	now: () => Date = () => new Date(),
): ToolModule {
	const policy = (): PathPolicy => policyOverride ?? loadPolicy();

	/** Validate a vault-relative path: no absolute paths, `..` or hidden segments. Adds .md. */
	function cleanRel(input: string, opts: { allowEmpty?: boolean } = {}): string {
		const s = input.trim();
		if (s.includes("\0") || s.includes("\\")) throw new PathPolicyError("Invalid path.");
		if (s.startsWith("/") || s.startsWith("~") || /^[A-Za-z]:/.test(s)) {
			throw new PathPolicyError("Paths must be relative to the vault (no absolute paths).");
		}
		const segs = s.split("/").filter((x) => x !== "" && x !== ".");
		if (segs.some((x) => x === "..")) {
			throw new PathPolicyError("Paths must stay inside the vault ('..' is not allowed).");
		}
		if (segs.some((x) => x.startsWith("."))) {
			throw new PathPolicyError("Hidden folders/files (.obsidian, .trash, ...) are off limits.");
		}
		if (segs.length === 0 && !opts.allowEmpty) throw new PathPolicyError("Empty path.");
		return segs.join("/");
	}
	const noteRel = (input: string): string => {
		const r = cleanRel(input);
		return /\.md$/i.test(r) ? r : `${r}.md`;
	};

	async function resolveVault(input: string | undefined): Promise<Vault> {
		const records = await bridge.registry();
		if (records.length === 0) {
			throw new UserError(
				"No Obsidian vaults found (is Obsidian installed and has it opened a vault?).",
			);
		}
		let rec: VaultRecord | undefined;
		if (input === undefined || input.trim() === "") {
			const open = records.filter((r) => r.open);
			const pool = open.length === 1 ? open : records;
			if (pool.length !== 1) {
				throw new UserError(
					`Several vaults exist; pass vault. Options: ${records
						.map((r) => basename(r.path))
						.join(", ")}`,
				);
			}
			rec = pool[0];
		} else {
			const q = input.trim();
			const asPath = expandHome(q);
			const byId = records.filter((r) => r.id === q);
			const byPath = records.filter((r) => r.path === asPath || r.path === asPath.replace(/\/$/, ""));
			const byName = records.filter((r) => basename(r.path) === q);
			const byNameCi = records.filter((r) => basename(r.path).toLowerCase() === q.toLowerCase());
			const hit = [byId, byPath, byName, byNameCi].find((g) => g.length > 0) ?? [];
			if (hit.length > 1) {
				throw new UserError(`Vault name '${q}' is ambiguous; use the full path: ${hit.map((r) => r.path).join(", ")}`);
			}
			rec = hit[0];
			if (!rec) {
				throw new UserError(
					`Unknown vault '${q}'. Known vaults: ${records.map((r) => basename(r.path)).join(", ")}`,
				);
			}
		}
		if (!rec) throw new UserError("Vault not found.");
		let root: string;
		try {
			root = resolveAllowedPath(rec.path, "read", policy());
		} catch (e) {
			if (e instanceof PathPolicyError) {
				throw new PathPolicyError(
					`Vault ${basename(rec.path)} is outside the allowed locations. ` +
						"Add it via APPLE_MCP_FILE_ROOTS to allow access.",
				);
			}
			throw e;
		}
		return { record: rec, root, name: basename(rec.path) };
	}

	/** Absolute, canonical, policy-checked path inside the vault. */
	function absIn(v: Vault, rel: string, mode: "read" | "write"): string {
		const abs = resolveAllowedPath(join(v.root, rel), mode, policy());
		if (!abs.startsWith(v.root + sep)) {
			throw new PathPolicyError("Path resolves outside the vault (symlink?).");
		}
		return abs;
	}

	async function allNotes(v: Vault, folder = ""): Promise<{ files: NoteFile[]; truncated: boolean }> {
		const dir = folder ? absIn(v, cleanRel(folder), "read") : v.root;
		return bridge.listNotes(dir, true, MAX_SCAN_FILES).then((r) => ({
			truncated: r.truncated,
			files: folder ? r.files.map((f) => ({ ...f, rel: `${cleanRel(folder)}/${f.rel}` })) : r.files,
		}));
	}

	/** Resolve a path or [[wikilink]]-style name to an existing vault-relative note path. */
	async function findNote(v: Vault, ref: string): Promise<string> {
		const cleaned = ref
			.trim()
			.replace(/^!?\[\[|\]\]$/g, "")
			.replace(/[|#^].*$/, "")
			.trim();
		if (!cleaned) throw new UserError("Empty note reference.");
		const rel = noteRel(cleaned);
		const direct = await bridge.stat(absIn(v, rel, "read"));
		if (direct?.type === "file") return rel;
		const { files } = await allNotes(v);
		const wanted = rel.toLowerCase();
		const hasDir = rel.includes("/");
		const hits = files.filter((f) => {
			const l = f.rel.toLowerCase();
			return hasDir ? l === wanted || l.endsWith(`/${wanted}`) : basename(l) === wanted;
		});
		if (hits.length === 1) return (hits[0] as NoteFile).rel;
		if (hits.length === 0) {
			throw new UserError(`Note '${cleaned}' not found in vault ${v.name}. Try obsidian_search_notes.`);
		}
		throw new UserError(
			`Note name '${cleaned}' is ambiguous in vault ${v.name}. Use one of these paths: ` +
				hits
					.slice(0, 10)
					.map((h) => h.rel)
					.join(", "),
		);
	}

	async function readNoteText(v: Vault, rel: string): Promise<string> {
		const text = await bridge.readText(absIn(v, rel, "read"), MAX_NOTE_BYTES);
		if (text === null) throw new UserError(`Note not found: ${rel}`);
		return text;
	}

	const vaultField = z
		.string()
		.trim()
		.min(1)
		.optional()
		.describe(
			"Vault folder name, vault id or full path (see obsidian_list_vaults). Optional if " +
				"only one vault exists or exactly one is currently open.",
		);

	async function writeCreate(abs: string, content: string): Promise<CallToolResult | null> {
		try {
			await bridge.write(abs, content, "create");
			return null;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "EEXIST") {
				return errorResult("Note already exists. Use mode overwrite/append/prepend.");
			}
			throw e;
		}
	}

	return toolModule([
		defineTool({
			name: "obsidian_list_vaults",
			description:
				"List the Obsidian vaults on this Mac: name (folder name), path, number of notes, " +
				"when last opened and whether it is currently open in Obsidian. Start here to get " +
				"the vault name the other obsidian_* tools take.",
			schema: z.object({}),
			async run() {
				const records = await bridge.registry();
				const rows = [];
				for (const r of records) {
					const base = { lastOpened: r.lastOpened, open: r.open };
					let root: string;
					try {
						root = resolveAllowedPath(r.path, "read", policy());
					} catch (e) {
						if (e instanceof PathPolicyError) rows.push({ name: OUTSIDE, ...base });
						else throw e;
						continue;
					}
					const st = await bridge.stat(root);
					if (st?.type !== "dir") {
						rows.push({ name: basename(r.path), path: root, ...base, error: "folder missing" });
						continue;
					}
					const { files, truncated } = await bridge.listNotes(root, true, 100_000);
					rows.push({
						name: basename(r.path),
						path: root,
						notes: files.length,
						...(truncated ? { notesTruncated: true } : {}),
						...base,
					});
				}
				return dataResult(`${rows.length} vault(s).`, rows);
			},
		}),

		defineTool({
			name: "obsidian_list_notes",
			description:
				"List Markdown notes in an Obsidian vault (optionally one folder), newest-modified " +
				"first. Returns vault-relative path, title, modified time and size. Skips .obsidian, " +
				".trash and other dot-folders. Use obsidian_search_notes to find by content.",
			schema: z.object({
				vault: vaultField,
				folder: z.string().trim().optional().describe("Folder inside the vault, e.g. 'Projects'"),
				recursive: z.boolean().default(true).describe("Include subfolders"),
				limit: z.number().int().min(1).max(500).default(50),
			}),
			async run(a) {
				const v = await resolveVault(a.vault);
				const folder = a.folder ? cleanRel(a.folder, { allowEmpty: true }) : "";
				const dir = folder ? absIn(v, folder, "read") : v.root;
				const st = await bridge.stat(dir);
				if (st?.type !== "dir") return errorResult(`Folder not found in vault: ${folder}`);
				const { files, truncated } = await bridge.listNotes(dir, a.recursive, MAX_SCAN_FILES);
				files.sort((x, y) => y.modifiedMs - x.modifiedMs);
				const rows = files.slice(0, a.limit).map((f) => ({
					path: folder ? `${folder}/${f.rel}` : f.rel,
					title: titleOf(f.rel),
					modified: iso(f.modifiedMs),
					size: f.size,
				}));
				const more =
					files.length > a.limit || truncated
						? ` Showing ${rows.length} of ${files.length}${truncated ? "+" : ""}; raise limit or narrow folder.`
						: "";
				return dataResult(`${rows.length} note(s) in ${v.name}.${more}`, rows);
			},
		}),

		defineTool({
			name: "obsidian_search_notes",
			description:
				"Search an Obsidian vault by file name and content (case-insensitive; every word " +
				"must appear). Optional tag filter (#tag in the body or tags: in frontmatter; " +
				"parent tags match nested ones) and folder. Returns vault-relative path, title, " +
				"modified time and 1-2 context snippets. Name matches rank first, then newest. " +
				"Files over 1 MB are matched by name only.",
			schema: z.object({
				vault: vaultField,
				query: z.string().trim().min(1).optional().describe("Words to find"),
				tag: z.string().trim().min(1).optional().describe("Tag, with or without #"),
				folder: z.string().trim().optional().describe("Restrict to this vault folder"),
				limit: z.number().int().min(1).max(100).default(20),
			}),
			async run(a) {
				if (!a.query && !a.tag) return errorResult("Provide query and/or tag.");
				const v = await resolveVault(a.vault);
				const words = (a.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
				const tag = a.tag ? normTag(a.tag).toLowerCase() : null;
				const folder = a.folder ? cleanRel(a.folder, { allowEmpty: true }) : "";
				const { files, truncated } = await allNotes(v, folder);
				const hits: {
					path: string;
					title: string;
					modified: string;
					snippets: string[];
					nameMatch: boolean;
					ms: number;
				}[] = [];
				for (let i = 0; i < files.length; i += 32) {
					const batch = files.slice(i, i + 32);
					const texts = await Promise.all(
						batch.map((f) =>
							f.size <= MAX_SCAN_BYTES
								? bridge.readText(absIn(v, f.rel, "read"), MAX_SCAN_BYTES).catch(() => null)
								: Promise.resolve(null),
						),
					);
					batch.forEach((f, j) => {
						const text = texts[j] ?? "";
						const lowText = text.toLowerCase();
						const lowName = f.rel.toLowerCase();
						if (!words.every((w) => lowName.includes(w) || lowText.includes(w))) return;
						if (tag) {
							const sp = splitFrontmatter(text);
							const tags = extractTags(sp.raw ? parseFrontmatter(sp.raw) : {}, sp.body);
							if (!tags.some((t) => t.toLowerCase() === tag || t.toLowerCase().startsWith(`${tag}/`))) {
								return;
							}
						}
						const snippets: string[] = [];
						for (const w of words) {
							const idx = lowText.indexOf(w);
							if (idx >= 0 && snippets.length < 2) {
								const s = snippetAround(text, idx, w.length);
								if (!snippets.includes(s)) snippets.push(s);
							}
						}
						hits.push({
							path: f.rel,
							title: titleOf(f.rel),
							modified: iso(f.modifiedMs),
							snippets,
							nameMatch: words.length > 0 && words.every((w) => lowName.includes(w)),
							ms: f.modifiedMs,
						});
					});
				}
				hits.sort((x, y) => Number(y.nameMatch) - Number(x.nameMatch) || y.ms - x.ms);
				const rows = hits.slice(0, a.limit).map(({ nameMatch: _n, ms: _m, ...r }) => r);
				const note =
					(hits.length > a.limit ? ` Showing ${a.limit} of ${hits.length} matches.` : "") +
					(truncated ? ` Scan stopped at ${MAX_SCAN_FILES} notes.` : "");
				return dataResult(`${hits.length} match(es) in ${v.name}.${note}`, rows);
			},
		}),

		defineTool({
			name: "obsidian_read_note",
			description:
				"Read one Obsidian note by vault-relative path ('Projects/Plan.md') or by note name " +
				"as in a [[wikilink]] ('Plan'; an ambiguous name returns the candidate paths). " +
				"Returns parsed frontmatter (scalars and lists), the body (paged with offset/limit " +
				"in characters), outgoing [[links]]/embeds and tags. includeBacklinks scans the " +
				"vault for notes linking here (capped at 50).",
			schema: z.object({
				vault: vaultField,
				note: z.string().trim().min(1).describe("Vault-relative path or note name"),
				offset: z.number().int().min(0).default(0).describe("First body character to return"),
				limit: z.number().int().min(1).max(200_000).default(DEFAULT_BODY_CHARS),
				includeBacklinks: z.boolean().default(false),
			}),
			async run(a) {
				const v = await resolveVault(a.vault);
				const rel = await findNote(v, a.note);
				const abs = absIn(v, rel, "read");
				const text = await readNoteText(v, rel);
				const st = await bridge.stat(abs);
				const sp = splitFrontmatter(text);
				const fm = sp.raw === null ? {} : parseFrontmatter(sp.raw);
				const slice = sp.body.slice(a.offset, a.offset + a.limit);
				const end = a.offset + slice.length;
				const meta: Record<string, unknown> = {
					vault: v.name,
					path: rel,
					title: titleOf(rel),
					modified: st ? iso(st.modifiedMs) : null,
					frontmatter: fm,
					tags: extractTags(fm, sp.body),
					links: extractLinks(sp.body),
					bodyChars: sp.body.length,
					offset: a.offset,
					...(end < sp.body.length ? { truncated: true, nextOffset: end } : {}),
				};
				if (a.includeBacklinks) {
					const base = titleOf(rel).toLowerCase();
					const relNoExt = rel.replace(/\.md$/i, "").toLowerCase();
					const { files } = await allNotes(v);
					const backlinks: { path: string; title: string }[] = [];
					let scanned = 0;
					for (const f of files) {
						if (f.rel === rel || f.size > MAX_SCAN_BYTES) continue;
						if (++scanned > MAX_BACKLINK_FILES || backlinks.length >= 50) break;
						const t = await bridge.readText(absIn(v, f.rel, "read"), MAX_SCAN_BYTES).catch(() => null);
						if (!t || !t.includes("[[")) continue;
						const linked = extractLinks(t).some((l) => {
							const tgt = l.target.replace(/\.md$/i, "").toLowerCase();
							return tgt === base || tgt === relNoExt || relNoExt.endsWith(`/${tgt}`);
						});
						if (linked) backlinks.push({ path: f.rel, title: titleOf(f.rel) });
					}
					meta.backlinks = backlinks;
					if (scanned > MAX_BACKLINK_FILES || backlinks.length >= 50) meta.backlinksCapped = true;
				}
				return textResult(`${JSON.stringify(meta, null, 2)}\n\n--- body ---\n${slice}`);
			},
		}),

		defineTool({
			name: "obsidian_write_note",
			description:
				"Create or modify a Markdown note in an Obsidian vault. mode 'create' (default) " +
				"fails if the note exists; 'append' adds content at the end and 'prepend' right " +
				"after the frontmatter (both need an existing note, no confirmation); 'overwrite' " +
				"replaces the whole note and, if it exists, requires confirm: true (preview first). " +
				"Folders are created as needed. The path is vault-relative; '.md' is added " +
				"if missing. Writes inside .obsidian or other dot-folders are refused.",
			schema: z.object({
				vault: vaultField,
				path: z.string().trim().min(1).describe("Vault-relative path, e.g. 'Ideas/New.md'"),
				content: z.string().max(1_000_000).describe("Markdown to write"),
				mode: z.enum(["create", "overwrite", "append", "prepend"]).default("create"),
				confirm: confirmField,
			}),
			async run(a) {
				const v = await resolveVault(a.vault);
				const rel = noteRel(a.path);
				const abs = absIn(v, rel, "write");
				const st = await bridge.stat(abs);
				if (st && st.type !== "file") return errorResult(`${rel} is not a file.`);
				if (a.mode === "create") {
					if (st) return errorResult(`Note already exists: ${rel}. Use append, prepend or overwrite.`);
					return (await writeCreate(abs, a.content)) ?? dataResult(`Created ${rel}.`, { path: rel });
				}
				if (a.mode === "overwrite") {
					if (!st) {
						return (
							(await writeCreate(abs, a.content)) ?? dataResult(`Created ${rel}.`, { path: rel })
						);
					}
					return withConfirm(
						a.confirm,
						() =>
							`Would overwrite ${rel} in ${v.name} (${st.size} bytes) with ${a.content.length} characters.`,
						async () => {
							await bridge.write(abs, a.content, "overwrite");
							return dataResult(`Overwrote ${rel}.`, { path: rel });
						},
					);
				}
				if (!st) {
					return errorResult(`Note not found: ${rel}. Use mode create to make it.`);
				}
				const existing = await readNoteText(v, rel);
				const next =
					a.mode === "append"
						? appendText(existing, a.content)
						: prependAfterFrontmatter(existing, a.content);
				await bridge.write(abs, next, "overwrite");
				return dataResult(`${a.mode === "append" ? "Appended to" : "Prepended to"} ${rel}.`, {
					path: rel,
				});
			},
		}),

		defineTool({
			name: "obsidian_daily_note",
			description:
				"Read or append to the daily note of an Obsidian vault (today by default, or a " +
				"date given as YYYY-MM-DD). Honors the vault's daily-notes settings (folder, date " +
				"format, simple template). 'append' adds text at the end and creates the note " +
				"(from the template, if any) when it does not exist yet; no confirmation needed.",
			schema: z.object({
				vault: vaultField,
				action: z.enum(["read", "append"]).default("read"),
				date: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
					.optional()
					.describe("Defaults to today"),
				content: z.string().max(1_000_000).optional().describe("Text to append (action append)"),
				limit: z.number().int().min(1).max(200_000).default(DEFAULT_BODY_CHARS),
			}),
			async run(a) {
				const v = await resolveVault(a.vault);
				let day = now();
				if (a.date) {
					const [y, m, d] = a.date.split("-").map(Number) as [number, number, number];
					day = new Date(y, m - 1, d, 12);
					if (day.getMonth() !== m - 1) return errorResult(`Invalid date: ${a.date}`);
				}
				const cfg = (await bridge.readJson(join(v.root, ".obsidian", "daily-notes.json"))) as {
					folder?: unknown;
					format?: unknown;
					template?: unknown;
				} | null;
				const format = typeof cfg?.format === "string" && cfg.format ? cfg.format : "YYYY-MM-DD";
				const folder = typeof cfg?.folder === "string" ? cfg.folder : "";
				const name = formatMoment(day, format);
				const rel = noteRel(folder ? `${folder}/${name}` : name);
				const abs = absIn(v, rel, a.action === "read" ? "read" : "write");
				const st = await bridge.stat(abs);
				if (a.action === "read") {
					if (!st) return textResult(`No daily note yet for ${formatMoment(day, "YYYY-MM-DD")} (would be ${rel}).`);
					const text = await readNoteText(v, rel);
					const out = text.slice(0, a.limit);
					const tr = out.length < text.length ? `\n\n[truncated: ${text.length} chars total]` : "";
					return textResult(`${rel}\n\n${out}${tr}`);
				}
				if (!a.content) return errorResult("content is required for action append.");
				if (st && st.type !== "file") return errorResult(`${rel} is not a file.`);
				if (st) {
					await bridge.write(abs, appendText(await readNoteText(v, rel), a.content), "overwrite");
					return dataResult(`Appended to ${rel}.`, { path: rel, created: false });
				}
				let base = "";
				if (typeof cfg?.template === "string" && cfg.template.trim()) {
					try {
						const t = await bridge.readText(absIn(v, noteRel(cfg.template), "read"), MAX_NOTE_BYTES);
						base = (t ?? "")
							.replace(/\{\{date(?::([^}]+))?\}\}/g, (_m, f?: string) => formatMoment(day, f ?? "YYYY-MM-DD"))
							.replace(/\{\{time(?::([^}]+))?\}\}/g, (_m, f?: string) => formatMoment(now(), f ?? "HH:mm"))
							.replace(/\{\{title\}\}/g, titleOf(rel));
					} catch {
						base = ""; // unusable template: fall back to an empty note
					}
				}
				const err = await writeCreate(abs, appendText(base, a.content));
				return err ?? dataResult(`Created ${rel} and added the text.`, { path: rel, created: true });
			},
		}),

		defineTool({
			name: "obsidian_open_note",
			description:
				"Open a vault, or a note in it, in the Obsidian app (obsidian:// URL). Brings " +
				"Obsidian to the front: only use when the user wants to see the note. To read " +
				"content use obsidian_read_note.",
			schema: z.object({
				vault: vaultField,
				note: z.string().trim().min(1).optional().describe("Vault-relative path or note name"),
			}),
			async run(a) {
				const v = await resolveVault(a.vault);
				let url = `obsidian://open?vault=${encodeURIComponent(v.record.id)}`;
				let what = `vault ${v.name}`;
				if (a.note) {
					const rel = await findNote(v, a.note);
					url += `&file=${encodeURIComponent(rel.replace(/\.md$/i, ""))}`;
					what = `${rel} in ${v.name}`;
				}
				await bridge.openUrl(url);
				return textResult(`Opened ${what} in Obsidian.`);
			},
		}),
	]);
}
