import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The only file that touches the OS for Shortcuts: the /usr/bin/shortcuts CLI.
// `shortcuts list` is fast (~20-50ms measured) but a result cache keeps repeated
// name resolution (list -> run -> view) from re-spawning it.

const SHORTCUTS_BIN = "/usr/bin/shortcuts";
const LIST_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 30_000;
const MAX_TEXT_CHARS = 100_000;

export interface ShortcutInfo {
	name: string;
	identifier: string;
	/** Folder name, or null when the shortcut is not in a folder. */
	folder: string | null;
}

export interface ShortcutFolder {
	name: string;
	identifier: string;
}

export interface ShortcutCatalog {
	shortcuts: ShortcutInfo[];
	folders: ShortcutFolder[];
}

export type ShortcutOutput =
	| { kind: "text"; text: string; truncated: boolean; chars: number }
	| { kind: "file"; path: string; type: string; bytes: number };

export interface RunRequest {
	identifier: string;
	/** Text piped to the shortcut as input (written to a temp file that is deleted after). */
	inputText?: string;
	/** An already-validated file path passed as the shortcut input. */
	inputPath?: string;
	captureOutput: boolean;
	timeoutMs: number;
}

export interface RunResult {
	exitCode: number | null;
	timedOut: boolean;
	stdout: string;
	stderr: string;
	/** Present when captureOutput was requested and the shortcut produced output. */
	output: ShortcutOutput | null;
}

export interface ShortcutsBridge {
	/** List shortcuts and folders (cached ~30s unless refresh is true). */
	catalog(refresh?: boolean): Promise<ShortcutCatalog>;
	run(req: RunRequest): Promise<RunResult>;
	/** Opens the shortcut in the Shortcuts editor (UI side effect). */
	view(name: string): Promise<void>;
}

export interface ExecResult {
	code: number | null;
	timedOut: boolean;
	stdout: string;
	stderr: string;
}
export type ExecFn = (args: string[], timeoutMs: number) => Promise<ExecResult>;

const realExec: ExecFn = (args, timeoutMs) =>
	new Promise((resolve, reject) => {
		execFile(
			SHORTCUTS_BIN,
			args,
			{ timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) {
					const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
					if (e.code === "ENOENT") {
						reject(new Error(`${SHORTCUTS_BIN} not found (requires macOS 12 or later).`));
						return;
					}
					resolve({
						code: typeof e.code === "number" ? e.code : null,
						timedOut: Boolean(e.killed),
						stdout: String(stdout),
						stderr: String(stderr || e.message),
					});
					return;
				}
				resolve({ code: 0, timedOut: false, stdout: String(stdout), stderr: String(stderr) });
			},
		);
	});

const ID_LINE = /^(.*) \(([0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12})\)$/;

/** Parse `name (UUID)` lines from `--show-identifiers` output. */
export function parseIdentifierLines(out: string): { name: string; identifier: string }[] {
	const rows: { name: string; identifier: string }[] = [];
	for (const raw of out.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const m = ID_LINE.exec(line);
		if (m) rows.push({ name: m[1]!, identifier: m[2]! });
	}
	return rows;
}

function listFailure(what: string, r: ExecResult): Error {
	if (r.timedOut) return new Error(`'shortcuts ${what}' timed out.`);
	return new Error(`'shortcuts ${what}' failed: ${r.stderr.trim() || `exit ${r.code}`}`);
}

function sniffType(buf: Buffer, bytes: number): string {
	const head = buf.subarray(0, 12);
	const starts = (s: string): boolean => head.subarray(0, s.length).toString("latin1") === s;
	if (starts("\x89PNG")) return "public.png";
	if (head[0] === 0xff && head[1] === 0xd8) return "public.jpeg";
	if (starts("%PDF")) return "com.adobe.pdf";
	if (starts("GIF8")) return "com.compuserve.gif";
	if (starts("PK")) return "public.zip-archive";
	if (head.subarray(4, 8).toString("latin1") === "ftyp") return "public.mpeg-4";
	return bytes === 0 ? "public.data (empty)" : "public.data";
}

export interface BridgeOptions {
	exec?: ExecFn;
	now?: () => number;
	ttlMs?: number;
}

/** Factory so tests can inject the process runner and a clock (cache behaviour). */
export function createShortcutsBridge(opts: BridgeOptions = {}): ShortcutsBridge {
	const exec = opts.exec ?? realExec;
	const now = opts.now ?? Date.now;
	const ttl = opts.ttlMs ?? CACHE_TTL_MS;
	let cache: { at: number; value: ShortcutCatalog } | null = null;
	let inflight: Promise<ShortcutCatalog> | null = null;

	async function load(): Promise<ShortcutCatalog> {
		const [all, folderRes] = await Promise.all([
			exec(["list", "--show-identifiers"], LIST_TIMEOUT_MS),
			exec(["list", "--folders", "--show-identifiers"], LIST_TIMEOUT_MS),
		]);
		if (all.code !== 0) throw listFailure("list", all);
		if (folderRes.code !== 0) throw listFailure("list --folders", folderRes);
		const folders = parseIdentifierLines(folderRes.stdout);
		const folderOf = new Map<string, string>();
		for (const f of folders) {
			const r = await exec(
				["list", "--folder-name", f.identifier, "--show-identifiers"],
				LIST_TIMEOUT_MS,
			);
			if (r.code !== 0) throw listFailure(`list --folder-name ${f.name}`, r);
			for (const s of parseIdentifierLines(r.stdout)) folderOf.set(s.identifier, f.name);
		}
		return {
			shortcuts: parseIdentifierLines(all.stdout).map((s) => ({
				...s,
				folder: folderOf.get(s.identifier) ?? null,
			})),
			folders,
		};
	}

	return {
		async catalog(refresh = false): Promise<ShortcutCatalog> {
			if (!refresh && cache && now() - cache.at < ttl) return cache.value;
			if (!inflight) {
				inflight = load()
					.then((value) => {
						cache = { at: now(), value };
						return value;
					})
					.finally(() => {
						inflight = null;
					});
			}
			return inflight;
		},

		async run(req: RunRequest): Promise<RunResult> {
			const dir = mkdtempSync(join(tmpdir(), "apple-mcp-shortcuts-"));
			let keepDir = false;
			try {
				const args = ["run", req.identifier];
				if (req.inputText !== undefined) {
					const p = join(dir, "input.txt");
					writeFileSync(p, req.inputText, { mode: 0o600 });
					args.push("--input-path", p);
				} else if (req.inputPath !== undefined) {
					args.push("--input-path", req.inputPath);
				}
				const outPath = join(dir, "output");
				if (req.captureOutput) args.push("--output-path", outPath);

				const r = await exec(args, req.timeoutMs);
				const result: RunResult = {
					exitCode: r.code,
					timedOut: r.timedOut,
					stdout: r.stdout,
					stderr: r.stderr,
					output: null,
				};
				if (req.captureOutput && !r.timedOut && r.code === 0) {
					let size = -1;
					try {
						size = statSync(outPath).size;
					} catch {
						// no output produced
					}
					if (size >= 0) {
						const buf = readFileSync(outPath);
						let text: string | null = null;
						try {
							text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
							if (text.includes("\0")) text = null;
						} catch {
							text = null;
						}
						if (text !== null) {
							result.output = {
								kind: "text",
								text: text.slice(0, MAX_TEXT_CHARS),
								truncated: text.length > MAX_TEXT_CHARS,
								chars: text.length,
							};
						} else {
							keepDir = true;
							result.output = {
								kind: "file",
								path: outPath,
								type: sniffType(buf, size),
								bytes: size,
							};
						}
					}
				}
				return result;
			} finally {
				if (!keepDir) rmSync(dir, { recursive: true, force: true });
				else rmSync(join(dir, "input.txt"), { force: true });
			}
		},

		async view(name: string): Promise<void> {
			const r = await exec(["view", name], LIST_TIMEOUT_MS);
			if (r.code !== 0) {
				throw new Error(`'shortcuts view' failed: ${r.stderr.trim() || `exit ${r.code}`}`);
			}
		},
	};
}

export const shortcutsBridge: ShortcutsBridge = createShortcutsBridge();
