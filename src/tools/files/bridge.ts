import { execFile } from "node:child_process";
import {
	closeSync,
	constants,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { runJxa } from "../../lib/applescript.js";

export type EntryType = "file" | "dir" | "symlink" | "other";

export interface FileEntry {
	path: string;
	name: string;
	type: EntryType;
	size: number;
	modified: string;
}

export interface FileInfo {
	path: string;
	name: string;
	type: EntryType;
	kind: string;
	size: number;
	created: string;
	modified: string;
	permissions: string;
	owner: number;
	symlinkTarget: string | null;
}

export interface ListOptions {
	depth: number;
	/** Glob-ish name pattern (`*`, `?`), case-insensitive; null = all. */
	pattern: string | null;
	includeHidden: boolean;
	limit: number;
	/** Policy filter: entries failing it are silently dropped (and not descended into). */
	allow: (abs: string) => boolean;
}

export interface ListResult {
	entries: FileEntry[];
	truncated: boolean;
}

export type TextRead =
	| { kind: "binary"; size: number }
	| { kind: "too_large"; size: number }
	| { kind: "text"; text: string; encoding: "utf-8" | "latin1"; size: number };

export type WriteMode = "create" | "overwrite" | "append";

/** The only part of the files module that touches the OS. All paths are already vetted. */
export interface FilesBridge {
	list(dir: string, opts: ListOptions): Promise<ListResult>;
	/** lstat-based; null if the path does not exist. */
	info(path: string): Promise<FileInfo | null>;
	readText(path: string): Promise<TextRead>;
	/** Rich text (docx, rtf, html, ...) converted to plain text with textutil. */
	readRich(path: string): Promise<string>;
	/** Read a file as text for preview purposes (head only, utf-8, may be null if binary). */
	peek(path: string, maxBytes: number): Promise<string | null>;
	write(path: string, content: string, mode: WriteMode, createDirs: boolean): Promise<void>;
	mkdir(path: string): Promise<void>;
	move(from: string, to: string): Promise<void>;
	trash(path: string): Promise<string | null>;
}

export const RICH_EXTENSIONS = new Set([
	".docx",
	".doc",
	".rtf",
	".rtfd",
	".odt",
	".html",
	".htm",
	".webarchive",
]);

const MAX_READ_BYTES = 20 * 1024 * 1024;

const KINDS: Record<string, string> = {
	".txt": "Plain text",
	".md": "Markdown",
	".json": "JSON",
	".csv": "CSV",
	".pdf": "PDF document",
	".png": "PNG image",
	".jpg": "JPEG image",
	".jpeg": "JPEG image",
	".gif": "GIF image",
	".heic": "HEIC image",
	".docx": "Word document",
	".doc": "Word document",
	".xlsx": "Excel spreadsheet",
	".pptx": "PowerPoint presentation",
	".rtf": "Rich text",
	".html": "HTML document",
	".zip": "ZIP archive",
	".mp3": "MP3 audio",
	".m4a": "MPEG-4 audio",
	".mp4": "MPEG-4 video",
	".mov": "QuickTime movie",
	".ts": "TypeScript source",
	".js": "JavaScript source",
	".py": "Python source",
	".sh": "Shell script",
	".yaml": "YAML",
	".yml": "YAML",
	".app": "Application",
};

function typeOf(st: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): EntryType {
	if (st.isSymbolicLink()) return "symlink";
	if (st.isDirectory()) return "dir";
	if (st.isFile()) return "file";
	return "other";
}

export function kindOf(path: string, type: EntryType): string {
	if (type === "dir") return extname(path) === ".app" ? "Application" : "Folder";
	if (type === "symlink") return "Symbolic link";
	const ext = extname(path).toLowerCase();
	if (!ext) return "Document";
	return KINDS[ext] ?? `${ext.slice(1).toUpperCase()} file`;
}

export function globToRegExp(pattern: string): RegExp {
	const body = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${body}$`, "i");
}

function permString(mode: number): string {
	const chars = "rwxrwxrwx";
	let out = "";
	for (let i = 0; i < 9; i++) out += mode & (1 << (8 - i)) ? chars[i] : "-";
	return `${out} (${(mode & 0o777).toString(8)})`;
}

function entryFrom(path: string): FileEntry | null {
	try {
		const st = lstatSync(path);
		return {
			path,
			name: basename(path),
			type: typeOf(st),
			size: st.size,
			modified: st.mtime.toISOString(),
		};
	} catch {
		return null;
	}
}

function execText(cmd: string, args: string[], timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			cmd,
			args,
			{ timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
			(error, stdout, stderr) => {
				if (error) {
					reject(
						new Error(
							error.killed
								? `${cmd} timed out after ${timeoutMs}ms.`
								: `${cmd} failed: ${String(stderr || error.message).trim()}`,
						),
					);
					return;
				}
				resolve(stdout);
			},
		);
	});
}

/**
 * Self-contained JXA: move to Trash via NSFileManager. The resulting-URL out-param is
 * passed as null on purpose: reading it back through the bridge segfaults osascript.
 */
function trashJxa(args: { path: string }): boolean {
	ObjC.import("Foundation");
	const url = $.NSURL.fileURLWithPath(args.path);
	const err = (globalThis as any).Ref();
	const ok = $.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError(url, null, err);
	if (!ok) {
		const e = err[0];
		throw new Error(e ? ObjC.unwrap(e.localizedDescription) : "Could not move to Trash");
	}
	return true;
}

export const filesBridge: FilesBridge = {
	async list(dir, opts) {
		const entries: FileEntry[] = [];
		const re = opts.pattern ? globToRegExp(opts.pattern) : null;
		let truncated = false;
		const walk = (d: string, level: number): void => {
			let names: string[];
			try {
				names = readdirSync(d);
			} catch {
				return;
			}
			const found: FileEntry[] = [];
			for (const name of names) {
				if (!opts.includeHidden && name.startsWith(".")) continue;
				const full = join(d, name);
				if (!opts.allow(full)) continue;
				const e = entryFrom(full);
				if (e) found.push(e);
			}
			found.sort(
				(a, b) =>
					Number(b.type === "dir") - Number(a.type === "dir") ||
					a.name.localeCompare(b.name),
			);
			for (const e of found) {
				if (!re || re.test(e.name)) {
					if (entries.length >= opts.limit) {
						truncated = true;
						return;
					}
					entries.push(e);
				}
				if (e.type === "dir" && level < opts.depth) {
					walk(e.path, level + 1);
					if (truncated) return;
				}
			}
		};
		walk(dir, 0);
		return { entries, truncated };
	},

	async info(path) {
		let st: ReturnType<typeof lstatSync>;
		try {
			st = lstatSync(path);
		} catch {
			return null;
		}
		const type = typeOf(st);
		let target: string | null = null;
		if (type === "symlink") {
			try {
				target = readlinkSync(path);
			} catch {
				target = null;
			}
		}
		return {
			path,
			name: basename(path),
			type,
			kind: kindOf(path, type),
			size: st.size,
			created: st.birthtime.toISOString(),
			modified: st.mtime.toISOString(),
			permissions: permString(st.mode),
			owner: st.uid,
			symlinkTarget: target,
		};
	},

	async readText(path) {
		const size = statSync(path).size;
		if (size > MAX_READ_BYTES) return { kind: "too_large", size };
		const buf = readFileSync(path);
		if (buf.subarray(0, 8000).includes(0)) return { kind: "binary", size };
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
			return { kind: "text", text, encoding: "utf-8", size };
		} catch {
			return { kind: "text", text: buf.toString("latin1"), encoding: "latin1", size };
		}
	},

	async readRich(path) {
		return execText("textutil", ["-convert", "txt", "-stdout", path], 30_000);
	},

	async peek(path, maxBytes) {
		const buf = readFileSync(path).subarray(0, maxBytes);
		if (buf.includes(0)) return null;
		return buf.toString("utf8");
	},

	async write(path, content, mode, createDirs) {
		const parent = dirname(path);
		if (!existsSync(parent)) {
			if (!createDirs) {
				throw new Error(`Parent folder ${parent} does not exist. Pass createDirs: true.`);
			}
			mkdirSync(parent, { recursive: true });
		}
		if (mode === "create") {
			const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
			try {
				writeSync(fd, content);
			} finally {
				closeSync(fd);
			}
		} else if (mode === "append") {
			writeFileSync(path, content, { flag: "a" });
		} else {
			const tmp = join(parent, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
			try {
				const existing = existsSync(path) ? statSync(path).mode & 0o777 : 0o644;
				writeFileSync(tmp, content, { mode: existing });
				renameSync(tmp, path);
			} catch (e) {
				rmSync(tmp, { force: true });
				throw e;
			}
		}
	},

	async mkdir(path) {
		mkdirSync(path, { recursive: true });
	},

	async move(from, to) {
		try {
			renameSync(from, to);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
			cpSync(from, to, { recursive: true, errorOnExist: false, force: true });
			rmSync(from, { recursive: true });
		}
	},

	async trash(path) {
		await runJxa(trashJxa, { path }, { app: "the Trash", timeoutMs: 20_000 });
		return null;
	},
};
