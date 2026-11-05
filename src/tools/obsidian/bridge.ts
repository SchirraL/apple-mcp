import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	closeSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** One entry of Obsidian's vault registry (obsidian.json). */
export interface VaultRecord {
	id: string;
	path: string;
	/** ISO time the vault was last opened, if known. */
	lastOpened: string | null;
	open: boolean;
}

export interface NoteFile {
	/** Vault-relative path using "/" separators, including ".md". */
	rel: string;
	modifiedMs: number;
	size: number;
}

export interface StatResult {
	type: "file" | "dir" | "other";
	size: number;
	modifiedMs: number;
}

export type WriteKind = "create" | "overwrite";

export interface ObsidianBridge {
	/** Vaults known to the Obsidian app. Empty if Obsidian was never run. */
	registry(): Promise<VaultRecord[]>;
	/**
	 * Markdown files under `dirAbs` (a folder inside `vaultAbs`). Dot-folders (.obsidian,
	 * .trash, ...) and symlinks are skipped. Stops after `maxFiles` and sets `truncated`.
	 */
	listNotes(
		dirAbs: string,
		recursive: boolean,
		maxFiles: number,
	): Promise<{ files: NoteFile[]; truncated: boolean }>;
	stat(abs: string): Promise<StatResult | null>;
	/** UTF-8 text, or null when missing. Throws if the file exceeds `maxBytes`. */
	readText(abs: string, maxBytes: number): Promise<string | null>;
	/** Parsed JSON file, or null when missing/invalid. */
	readJson(abs: string): Promise<unknown | null>;
	/**
	 * create: fails with code EEXIST if present. overwrite: atomic (temp file + rename).
	 * Parent folders are created.
	 */
	write(abs: string, content: string, kind: WriteKind): Promise<void>;
	/** Hand a URL to macOS `open` (UI side effect). */
	openUrl(url: string): Promise<void>;
}

export const DEFAULT_CONFIG = join(
	homedir(),
	"Library",
	"Application Support",
	"obsidian",
	"obsidian.json",
);

export function createObsidianBridge(configPath: string = DEFAULT_CONFIG): ObsidianBridge {
	return {
		async registry() {
			let raw: unknown;
			try {
				raw = JSON.parse(readFileSync(configPath, "utf8"));
			} catch {
				return [];
			}
			const vaults = (raw as { vaults?: Record<string, unknown> } | null)?.vaults;
			if (!vaults || typeof vaults !== "object") return [];
			const out: VaultRecord[] = [];
			for (const [id, v] of Object.entries(vaults)) {
				const rec = v as { path?: unknown; ts?: unknown; open?: unknown };
				if (typeof rec?.path !== "string") continue;
				out.push({
					id,
					path: rec.path,
					lastOpened: typeof rec.ts === "number" ? new Date(rec.ts).toISOString() : null,
					open: rec.open === true,
				});
			}
			return out;
		},

		async listNotes(dirAbs, recursive, maxFiles) {
			const files: NoteFile[] = [];
			let truncated = false;
			const walk = (dir: string, relDir: string): void => {
				let entries: import("node:fs").Dirent[];
				try {
					entries = readdirSync(dir, { withFileTypes: true });
				} catch {
					return;
				}
				for (const e of entries) {
					if (truncated) return;
					if (e.name.startsWith(".")) continue;
					const rel = relDir ? `${relDir}/${e.name}` : e.name;
					if (e.isDirectory()) {
						if (recursive) walk(join(dir, e.name), rel);
					} else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
						if (files.length >= maxFiles) {
							truncated = true;
							return;
						}
						try {
							const st = statSync(join(dir, e.name));
							files.push({ rel, modifiedMs: st.mtimeMs, size: st.size });
						} catch {
							// vanished between readdir and stat
						}
					}
				}
			};
			walk(dirAbs, "");
			return { files, truncated };
		},

		async stat(abs) {
			try {
				const st = statSync(abs);
				return {
					type: st.isFile() ? "file" : st.isDirectory() ? "dir" : "other",
					size: st.size,
					modifiedMs: st.mtimeMs,
				};
			} catch {
				return null;
			}
		},

		async readText(abs, maxBytes) {
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(abs);
			} catch {
				return null;
			}
			if (!st.isFile()) return null;
			if (st.size > maxBytes) throw new Error(`File too large (${st.size} bytes)`);
			return readFileSync(abs, "utf8");
		},

		async readJson(abs) {
			try {
				return JSON.parse(readFileSync(abs, "utf8"));
			} catch {
				return null;
			}
		},

		async write(abs, content, kind) {
			mkdirSync(dirname(abs), { recursive: true });
			if (kind === "create") {
				const fd = openSync(abs, "wx"); // throws EEXIST rather than clobbering
				try {
					writeFileSync(fd, content, "utf8");
				} finally {
					closeSync(fd);
				}
				return;
			}
			const tmp = join(dirname(abs), `.${basename(abs)}.${randomBytes(4).toString("hex")}.tmp`);
			try {
				writeFileSync(tmp, content, { encoding: "utf8", flag: "wx" });
				renameSync(tmp, abs);
			} catch (e) {
				rmSync(tmp, { force: true });
				throw e;
			}
		},

		openUrl(url) {
			return new Promise((resolve, reject) => {
				execFile("open", [url], { timeout: 10_000 }, (err) => (err ? reject(err) : resolve()));
			});
		},
	};
}

export const obsidianBridge: ObsidianBridge = createObsidianBridge();
