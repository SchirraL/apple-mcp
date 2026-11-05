import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { basename, extname } from "node:path";
import { runJxa } from "../../lib/applescript.js";

export type FileKindFilter =
	| "pdf"
	| "image"
	| "document"
	| "presentation"
	| "spreadsheet"
	| "folder"
	| "audio"
	| "video"
	| "code";

export interface SpotlightRequest {
	/** Complete Spotlight query expression (built by buildSpotlightQuery). */
	query: string;
	/** Directory to search in (already policy-checked); defaults to the whole index. */
	folder?: string;
	/** Max raw candidate paths to read from mdfind. */
	maxCandidates: number;
}

export interface FileInfo {
	path: string;
	name: string;
	kind: string;
	size: number | null;
	modified: string | null;
}

export interface SelectionInfo {
	selection: string[];
	frontWindowFolder: string | null;
}

export interface FinderBridge {
	/** Raw paths from Spotlight (unfiltered, unordered). */
	spotlight(req: SpotlightRequest): Promise<{ paths: string[]; truncated: boolean }>;
	/** Metadata via fs.lstat; entries that vanished are omitted. Input order is kept. */
	stat(paths: string[]): Promise<FileInfo[]>;
	getSelection(): Promise<SelectionInfo>;
	/** Select the file in a Finder window (UI side effect). */
	reveal(path: string): Promise<void>;
	getTags(path: string): Promise<string[]>;
	setTags(path: string, tags: string[]): Promise<void>;
}

const EXT_KINDS: Record<string, string[]> = {
	pdf: ["pdf"],
	image: ["png", "jpg", "jpeg", "gif", "heic", "heif", "tif", "tiff", "bmp", "webp", "svg"],
	document: ["doc", "docx", "pages", "rtf", "odt", "txt", "md", "markdown", "epub"],
	presentation: ["ppt", "pptx", "key", "odp"],
	spreadsheet: ["xls", "xlsx", "numbers", "csv", "tsv", "ods"],
	audio: ["mp3", "m4a", "aac", "wav", "aiff", "flac", "ogg"],
	video: ["mp4", "mov", "m4v", "avi", "mkv", "webm"],
	code: ["ts", "tsx", "js", "jsx", "py", "rb", "go", "rs", "java", "c", "h", "cpp", "swift",
		"sh", "json", "yaml", "yml", "toml", "html", "css", "sql"],
};
const KIND_BY_EXT = new Map<string, string>(
	Object.entries(EXT_KINDS).flatMap(([k, exts]) => exts.map((e) => [e, k] as [string, string])),
);

/** Coarse kind from a path/extension (stat-only; avoids a per-file Spotlight lookup). */
export function kindOf(path: string, isDir: boolean): string {
	if (isDir) return extname(path).toLowerCase() === ".app" ? "app" : "folder";
	return KIND_BY_EXT.get(extname(path).slice(1).toLowerCase()) ?? "other";
}

function runMdfind(
	args: string[],
	maxBuffer: number,
): Promise<{ stdout: string; truncated: boolean }> {
	return new Promise((resolve, reject) => {
		execFile("mdfind", args, { timeout: 20_000, maxBuffer }, (error, stdout) => {
			const code = (error as NodeJS.ErrnoException | null)?.code;
			if (error && code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
				resolve({ stdout: String(stdout), truncated: true });
			} else if (error) {
				reject(new Error(`Spotlight search failed: ${error.killed ? "timed out" : error.message}`));
			} else {
				resolve({ stdout: String(stdout), truncated: false });
			}
		});
	});
}

// --- JXA bodies: serialised with toString(), so fully self-contained ---------------------

function selectionJxa(): SelectionInfo {
	ObjC.import("Foundation");
	const $: any = (globalThis as any).$;
	const toPath = (u: string): string => ObjC.unwrap($.NSURL.URLWithString(u).path) as string;
	const finder: any = Application("Finder");
	const sel: string[] = [];
	for (const item of finder.selection()) sel.push(toPath(item.url()));
	let folder: string | null = null;
	if (finder.finderWindows.length > 0) {
		folder = toPath(finder.finderWindows[0].target().url());
	}
	return { selection: sel, frontWindowFolder: folder };
}

function revealJxa(path: string): void {
	const finder: any = Application("Finder");
	finder.reveal(Path(path));
	finder.activate();
}

function getTagsJxa(path: string): string[] {
	ObjC.import("Foundation");
	const $: any = (globalThis as any).$;
	const url = $.NSURL.fileURLWithPath(path);
	const ref = (globalThis as any).Ref();
	const ok = url.getResourceValueForKeyError(ref, $.NSURLTagNamesKey, $());
	if (!ok) return [];
	const val = ref[0];
	if (!val || (typeof val.isNil === "function" && val.isNil())) return [];
	return (ObjC.deepUnwrap(val) as string[] | null) ?? [];
}

function setTagsJxa(a: { path: string; tags: string[] }): void {
	ObjC.import("Foundation");
	const $: any = (globalThis as any).$;
	const url = $.NSURL.fileURLWithPath(a.path);
	// JS arrays of ObjC objects don't bridge back to NSArray — build one natively.
	const arr = $.NSMutableArray.alloc.init;
	for (const t of a.tags) arr.addObject($(t));
	const ok = url.setResourceValueForKeyError(arr, $.NSURLTagNamesKey, $());
	if (!ok) throw new Error("Could not set tags (is the file writable?)");
}

export const finderBridge: FinderBridge = {
	async spotlight({ query, folder, maxCandidates }) {
		const args = folder ? ["-onlyin", folder, query] : [query];
		const { stdout, truncated } = await runMdfind(args, maxCandidates * 400);
		let paths = stdout.split("\n").filter(Boolean);
		if (truncated) paths = paths.slice(0, -1); // last line may be cut mid-path
		const over = paths.length > maxCandidates;
		return { paths: paths.slice(0, maxCandidates), truncated: truncated || over };
	},

	async stat(paths) {
		const out: (FileInfo | undefined)[] = new Array(paths.length);
		await Promise.all(
			paths.map(async (path, i) => {
				try {
					const s = await fs.lstat(path);
					out[i] = {
						path,
						name: basename(path),
						kind: kindOf(path, s.isDirectory()),
						size: s.isDirectory() ? null : s.size,
						modified: s.mtime.toISOString(),
					};
				} catch {
					// vanished since indexing
				}
			}),
		);
		return out.filter((x): x is FileInfo => x !== undefined);
	},

	getSelection: () => runJxa(selectionJxa, null as never, { app: "Finder" }),
	async reveal(path) {
		await runJxa(revealJxa, path, { app: "Finder" });
	},
	getTags: (path) => runJxa(getTagsJxa, path, { app: "Finder" }),
	async setTags(path, tags) {
		await runJxa(setTagsJxa, { path, tags }, { app: "Finder" });
	},
};
