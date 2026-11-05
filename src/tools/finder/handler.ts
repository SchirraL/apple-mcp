import { homedir } from "node:os";
import { join, sep } from "node:path";
import { z } from "zod";
import { isAllowedPath, loadPolicy, resolveAllowedPath } from "../../lib/paths.js";
import { confirmField, withConfirm } from "../../lib/safety.js";
import { dataResult, defineTool, type ToolModule, toolModule } from "../../lib/types.js";
import { type FileKindFilter, type FinderBridge, finderBridge } from "./bridge.js";

const KINDS = [
	"pdf",
	"image",
	"document",
	"presentation",
	"spreadsheet",
	"folder",
	"audio",
	"video",
	"code",
] as const satisfies readonly FileKindFilter[];

/** Spotlight content-type-tree predicates per kind filter. */
const KIND_TYPES: Record<FileKindFilter, string[]> = {
	pdf: ["com.adobe.pdf"],
	image: ["public.image"],
	document: ["public.composite-content", "public.plain-text", "net.daringfireball.markdown"],
	presentation: ["public.presentation"],
	spreadsheet: ["public.spreadsheet", "public.comma-separated-values-text"],
	folder: ["public.folder"],
	audio: ["public.audio"],
	video: ["public.movie"],
	code: ["public.source-code", "public.script", "public.json", "public.yaml", "public.xml"],
};

const MAX_TOKENS = 8;
const MAX_CANDIDATES = 2000;
const MAX_STATTED = 1000;
const MAX_TAGS = 20;

/**
 * Escape text for use inside a double-quoted Spotlight query string. Backslashes and quotes
 * are always escaped; `*` is escaped (literal) unless `wildcards` is true.
 */
export function escapeSpotlight(text: string, wildcards = false): string {
	let out = text.replace(/[\r\n\t]+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	if (!wildcards) out = out.replace(/\*/g, "\\*");
	return out;
}

function isoForSpotlight(value: string, label: string): string {
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) throw new Error(`${label} is not a valid ISO date: ${value}`);
	return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface SpotlightFilters {
	query?: string | undefined;
	nameOnly?: boolean | undefined;
	wildcards?: boolean | undefined;
	kind?: FileKindFilter | undefined;
	modifiedSince?: string | undefined;
	modifiedBefore?: string | undefined;
	/** Seconds back from now for kMDItemLastUsedDate. */
	usedWithinSeconds?: number | undefined;
}

/** Build a Spotlight query expression. Throws if no criterion is given. */
export function buildSpotlightQuery(f: SpotlightFilters): string {
	const parts: string[] = [];
	const tokens = (f.query ?? "").split(/\s+/).filter(Boolean).slice(0, MAX_TOKENS);
	for (const t of tokens) {
		const e = escapeSpotlight(t, f.wildcards);
		const name = `kMDItemFSName == "*${e}*"cd`;
		parts.push(f.nameOnly ? name : `(${name} || kMDItemTextContent == "${e}"cd)`);
	}
	if (f.kind) {
		const types = KIND_TYPES[f.kind].map((t) => `kMDItemContentTypeTree == "${t}"`);
		parts.push(types.length > 1 ? `(${types.join(" || ")})` : (types[0] as string));
	}
	if (f.modifiedSince) {
		parts.push(
			`kMDItemFSContentChangeDate >= $time.iso(${isoForSpotlight(f.modifiedSince, "modifiedSince")})`,
		);
	}
	if (f.modifiedBefore) {
		parts.push(
			`kMDItemFSContentChangeDate < $time.iso(${isoForSpotlight(f.modifiedBefore, "modifiedBefore")})`,
		);
	}
	if (f.usedWithinSeconds !== undefined) {
		parts.push(`kMDItemLastUsedDate >= $time.now(-${Math.round(f.usedWithinSeconds)})`);
	}
	if (parts.length === 0) {
		throw new Error("Provide at least one of query, kind, modifiedSince or modifiedBefore.");
	}
	return parts.join(" && ");
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function inLibrary(path: string): boolean {
	return path.startsWith(join(homedir(), "Library") + sep);
}

function sameTag(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

export function createFinderModule(bridge: FinderBridge = finderBridge): ToolModule {
	/** Run a Spotlight query, apply path policy, stat, sort newest first, cap. */
	async function searchAndRank(
		query: string,
		folder: string | undefined,
		limit: number,
	): Promise<{ files: Awaited<ReturnType<FinderBridge["stat"]>>; total: number; capped: boolean }> {
		// No folder: search every allowed root (APPLE_MCP_FILE_ROOTS), not just $HOME.
		const roots = folder ? [folder] : loadPolicy().roots;
		const parts = await Promise.all(
			roots.map((root) =>
				bridge.spotlight({ query, folder: root, maxCandidates: MAX_CANDIDATES }),
			),
		);
		const raw = {
			paths: [...new Set(parts.flatMap((r) => r.paths))],
			truncated: parts.some((r) => r.truncated),
		};
		// ~/Library is app-internal noise unless the caller searched inside it on purpose.
		const skipLibrary = !folder || !inLibrary(folder + sep);
		const allowed = raw.paths.filter(
			(p) => isAllowedPath(p) && !(skipLibrary && inLibrary(p)),
		);
		const files = await bridge.stat(allowed.slice(0, MAX_STATTED));
		files.sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""));
		return {
			files: files.slice(0, limit),
			total: allowed.length,
			capped: raw.truncated || allowed.length > MAX_STATTED,
		};
	}

	function resultSummary(
		n: number,
		total: number,
		capped: boolean,
		limit: number,
	): string {
		let s = `${plural(n, "file")} (sorted by last modified, newest first)`;
		if (total > n) s += `; ${total}${capped ? "+" : ""} matched, raise limit (max 200) or refine`;
		else if (n === limit) s += `; limit ${limit} reached`;
		return `${s}.`;
	}

	const kindField = z.enum(KINDS).optional().describe("Restrict to one kind of item");
	const limitField = z.number().int().min(1).max(200).default(30);
	const folderField = z
		.string()
		.optional()
		.describe("Only search inside this folder (default: all allowed roots, i.e. the home folder)");
	const pathField = z.string().min(1).describe("File or folder path (absolute, ~/..., or relative to home)");

	return toolModule([
		defineTool({
			name: "search_files",
			effect: "read",
			description:
				"Search files and folders with macOS Spotlight. 'query' matches file names and file " +
				"contents (all words must match); set nameOnly to match names only. '*' in the query is " +
				"literal unless wildcards is true. Filter by kind, modified date range and folder. " +
				"Results (path, name, kind, size, modified) are sorted newest-modified first and " +
				"limited to allowed folders. Only indexed locations are searched. For listing the " +
				"contents of one folder use the files tools instead.",
			schema: z.object({
				query: z.string().optional().describe("Words to look for in file names and contents"),
				nameOnly: z.boolean().default(false).describe("Match file names only, not contents"),
				wildcards: z
					.boolean()
					.default(false)
					.describe("Treat '*' in query as a wildcard instead of a literal asterisk"),
				kind: kindField,
				modifiedSince: z.string().optional().describe("ISO date/time: modified at or after"),
				modifiedBefore: z.string().optional().describe("ISO date/time: modified before"),
				folder: folderField,
				limit: limitField,
			}),
			async run(a) {
				const query = buildSpotlightQuery({
					query: a.query,
					nameOnly: a.nameOnly,
					wildcards: a.wildcards,
					kind: a.kind,
					modifiedSince: a.modifiedSince,
					modifiedBefore: a.modifiedBefore,
				});
				const folder = a.folder ? resolveAllowedPath(a.folder, "read") : undefined;
				const r = await searchAndRank(query, folder, a.limit);
				return dataResult(resultSummary(r.files.length, r.total, r.capped, a.limit), r.files);
			},
		}),

		defineTool({
			name: "list_recent_files",
			effect: "read",
			description:
				"List files and folders the user opened or used recently (Spotlight last-used date), " +
				"newest-modified first. Defaults to the last 7 days.",
			schema: z.object({
				days: z.number().min(0.01).max(365).default(7).describe("Look back this many days"),
				kind: kindField,
				folder: folderField,
				limit: limitField,
			}),
			async run(a) {
				const query = buildSpotlightQuery({
					kind: a.kind,
					usedWithinSeconds: a.days * 86400,
				});
				const folder = a.folder ? resolveAllowedPath(a.folder, "read") : undefined;
				const r = await searchAndRank(query, folder, a.limit);
				return dataResult(resultSummary(r.files.length, r.total, r.capped, a.limit), r.files);
			},
		}),

		defineTool({
			name: "get_finder_selection",
			effect: "read",
			description:
				"Read-only: the paths currently selected in the frontmost Finder window, plus the " +
				"folder that window shows. Empty when nothing is selected or no window is open. " +
				"Paths outside the allowed folders are left out.",
			schema: z.object({}),
			async run() {
				const s = await bridge.getSelection();
				const selection = s.selection.filter((p) => isAllowedPath(p));
				const hidden = s.selection.length - selection.length;
				const folder =
					s.frontWindowFolder && isAllowedPath(s.frontWindowFolder) ? s.frontWindowFolder : null;
				const note = hidden > 0 ? ` (${plural(hidden, "item")} outside allowed folders omitted)` : "";
				return dataResult(`${plural(selection.length, "selected item")}${note}.`, {
					selection,
					frontWindowFolder: folder,
				});
			},
		}),

		defineTool({
			name: "reveal_in_finder",
			effect: "write",
			description:
				"UI side effect: opens a Finder window showing the file or folder, selects it and " +
				"brings Finder to the front. Use only when the user wants to see it in Finder.",
			schema: z.object({ path: pathField }),
			async run({ path }) {
				const abs = resolveAllowedPath(path, "read");
				const found = await bridge.stat([abs]);
				if (found.length === 0) throw new Error(`No such file or folder: ${abs}`);
				await bridge.reveal(abs);
				return dataResult(`Revealed in Finder.`, { path: abs });
			},
		}),

		defineTool({
			name: "get_file_tags",
			effect: "read",
			description: "Read the Finder tags (e.g. 'Red', 'Work') of a file or folder.",
			schema: z.object({ path: pathField }),
			async run({ path }) {
				const abs = resolveAllowedPath(path, "read");
				const found = await bridge.stat([abs]);
				if (found.length === 0) throw new Error(`No such file or folder: ${abs}`);
				const tags = await bridge.getTags(abs);
				return dataResult(`${plural(tags.length, "tag")}.`, { path: abs, tags });
			},
		}),

		defineTool({
			name: "set_file_tags",
			effect: "write",
			description:
				"Change the Finder tags of a file or folder. mode 'add' (default) adds tags and needs " +
				"no confirmation; 'remove' removes the given tags and 'replace' sets exactly the " +
				"given tags (empty list clears all) -- both require confirm: true when they would " +
				"drop existing tags (otherwise they preview).",
			schema: z.object({
				path: pathField,
				tags: z
					.array(z.string().trim().min(1).max(100).refine((t) => !/[\r\n]/.test(t), "no newlines"))
					.max(MAX_TAGS)
					.describe("Tag names"),
				mode: z.enum(["add", "remove", "replace"]).default("add"),
				confirm: confirmField,
			}).refine((a) => a.mode === "replace" || a.tags.length > 0, {
				message: "tags may only be empty with mode 'replace' (to clear all tags)",
			}),
			async run({ path, tags, mode, confirm }) {
				const abs = resolveAllowedPath(path, "write");
				const found = await bridge.stat([abs]);
				if (found.length === 0) throw new Error(`No such file or folder: ${abs}`);
				const current = await bridge.getTags(abs);
				const unique = tags.filter((t, i) => tags.findIndex((u) => sameTag(u, t)) === i);

				let next: string[];
				let dropped: string[];
				if (mode === "add") {
					next = [...current, ...unique.filter((t) => !current.some((c) => sameTag(c, t)))];
					dropped = [];
				} else if (mode === "remove") {
					next = current.filter((c) => !unique.some((t) => sameTag(c, t)));
					dropped = current.filter((c) => unique.some((t) => sameTag(c, t)));
				} else {
					next = unique;
					dropped = current.filter((c) => !unique.some((t) => sameTag(c, t)));
				}

				const apply = async () => {
					if (next.length !== current.length || next.some((t, i) => t !== current[i])) {
						await bridge.setTags(abs, next);
					}
					return dataResult(`Tags are now: ${next.length ? next.join(", ") : "(none)"}.`, {
						path: abs,
						tags: next,
					});
				};
				if (dropped.length === 0) return apply();
				return withConfirm(
					confirm,
					() =>
						`Would change tags on ${abs}: ${mode} -> remove ${dropped.map((t) => `"${t}"`).join(", ")}; ` +
						`result: ${next.length ? next.join(", ") : "(no tags)"}.`,
					apply,
				);
			},
		}),
	]);
}
