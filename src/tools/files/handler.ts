import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
	isAllowedPath,
	loadPolicy,
	type PathPolicy,
	resolveAllowedPath,
} from "../../lib/paths.js";
import { confirmField, withConfirm } from "../../lib/safety.js";
import {
	dataResult,
	defineTool,
	errorResult,
	textResult,
	type ToolModule,
	toolModule,
} from "../../lib/types.js";
import { type FilesBridge, filesBridge, RICH_EXTENSIONS } from "./bridge.js";

const MAX_TEXT_CHARS = 100_000;
const DEFAULT_LINES = 2000;

const pathField = (what: string) => z.string().trim().min(1).describe(what);

function ext(path: string): string {
	const i = path.lastIndexOf(".");
	return i > path.lastIndexOf("/") ? path.slice(i).toLowerCase() : "";
}

function head(text: string, lines = 5): string {
	const l = text.split("\n").slice(0, lines).join("\n");
	return l.length > 400 ? `${l.slice(0, 400)}...` : l;
}

export function createFilesModule(
	bridge: FilesBridge = filesBridge,
	policyOverride?: PathPolicy,
): ToolModule {
	const policy = (): PathPolicy => policyOverride ?? loadPolicy();
	const resolve = (p: string, mode: "read" | "write"): string =>
		resolveAllowedPath(p, mode, policy());
	const allowed = (abs: string): boolean => {
		try {
			const real = realpathSync(abs);
			return isAllowedPath(real, policy());
		} catch {
			return false;
		}
	};

	return toolModule([
		defineTool({
			name: "list_files",
			description:
				"List files and folders in a directory (default: home). Returns path, name, type " +
				"(file/dir/symlink), size in bytes and modified time; folders first, then by name. " +
				"Use depth 1-5 to recurse and `pattern` (e.g. '*.pdf', 'report*') to filter by " +
				"name. For content/metadata search across the Mac use the Finder search tool.",
			schema: z.object({
				dir: z.string().trim().min(1).default("~").describe("Directory, e.g. ~/Documents"),
				depth: z.number().int().min(0).max(5).default(0).describe("0 = only this folder"),
				pattern: z.string().trim().min(1).optional().describe("Name glob: * and ? wildcards"),
				includeHidden: z.boolean().default(false),
				limit: z.number().int().min(1).max(1000).default(200),
			}),
			async run(a) {
				const dir = resolve(a.dir, "read");
				const info = await bridge.info(dir);
				if (!info) return errorResult(`Folder not found: ${dir}`);
				if (info.type !== "dir") return errorResult(`Not a folder: ${dir}`);
				const res = await bridge.list(dir, {
					depth: a.depth,
					pattern: a.pattern ?? null,
					includeHidden: a.includeHidden,
					limit: a.limit,
					allow: allowed,
				});
				const note = res.truncated
					? ` Truncated at ${a.limit}; narrow with pattern or raise limit.`
					: "";
				return dataResult(`${res.entries.length} entries in ${dir}.${note}`, res.entries);
			},
		}),

		defineTool({
			name: "get_file_info",
			description:
				"Get metadata for a file or folder: type, kind, size, created/modified dates, " +
				"permissions and symlink target (shown only if the target is an allowed location).",
			schema: z.object({ path: pathField("File or folder path") }),
			async run(a) {
				const abs = resolve(a.path, "read");
				const info = await bridge.info(abs);
				if (!info) return errorResult(`Not found: ${abs}`);
				if (info.symlinkTarget !== null) {
					const t = join(dirname(abs), info.symlinkTarget);
					if (!allowed(t)) info.symlinkTarget = "(outside allowed locations)";
				}
				return dataResult(`${info.kind}: ${abs}`, info);
			},
		}),

		defineTool({
			name: "read_file",
			description:
				"Read a text file (lines offset/limit, output capped at ~100 KB). Also extracts " +
				"plain text from .docx .doc .rtf .rtfd .odt .html .webarchive. Binary files are " +
				"refused; use read_pdf for PDFs. If truncated, call again with a higher offset.",
			schema: z.object({
				path: pathField("File path"),
				offset: z.number().int().min(0).default(0).describe("First line to return (0-based)"),
				limit: z.number().int().min(1).max(20000).default(DEFAULT_LINES).describe("Max lines"),
			}),
			async run(a) {
				const abs = resolve(a.path, "read");
				const info = await bridge.info(abs);
				if (!info) return errorResult(`Not found: ${abs}`);
				if (info.type === "dir" && ext(abs) !== ".rtfd") {
					return errorResult(`${abs} is a folder; use list_files.`);
				}
				const e = ext(abs);
				if (e === ".pdf") {
					return errorResult(`${abs} is a PDF; use read_pdf to extract its text.`);
				}
				let text: string;
				let note = "";
				if (RICH_EXTENSIONS.has(e)) {
					text = await bridge.readRich(abs);
				} else {
					const r = await bridge.readText(abs);
					if (r.kind === "binary") {
						return errorResult(
							`${abs} looks binary (${r.size} bytes). Not read. Use get_file_info for metadata.`,
						);
					}
					if (r.kind === "too_large") {
						return errorResult(`${abs} is too large to read (${r.size} bytes, limit 20 MB).`);
					}
					text = r.text;
					if (r.encoding === "latin1") {
						note = " Not valid UTF-8; decoded as Latin-1, some characters may be wrong.";
					}
				}
				const lines = text.split("\n");
				const slice = lines.slice(a.offset, a.offset + a.limit);
				let out = slice.join("\n");
				let end = a.offset + slice.length;
				if (out.length > MAX_TEXT_CHARS) {
					out = out.slice(0, MAX_TEXT_CHARS);
					end = a.offset + out.split("\n").length - 1;
				}
				const more =
					end < lines.length
						? ` Truncated: showing lines ${a.offset}-${end} of ${lines.length}; ` +
							`call again with offset ${end} for more.`
						: "";
				return textResult(
					`${abs} (${lines.length} lines).${note}${more}\n\n${out}`,
				);
			},
		}),

		defineTool({
			name: "write_file",
			description:
				"Write text to a file. mode 'create' (default) fails if the file exists; " +
				"'append' adds to the end; 'overwrite' replaces an existing file and needs " +
				"confirm: true (without it you get a preview). Parent folders are created only " +
				"with createDirs: true. Overwrites are atomic.",
			schema: z.object({
				path: pathField("Destination file path"),
				content: z.string().describe("Text content (UTF-8)"),
				mode: z.enum(["create", "overwrite", "append"]).default("create"),
				createDirs: z.boolean().default(false),
				confirm: confirmField,
			}),
			async run(a) {
				const abs = resolve(a.path, "write");
				const info = await bridge.info(abs);
				if (info && info.type === "dir") return errorResult(`${abs} is a folder.`);
				const bytes = Buffer.byteLength(a.content);
				if (a.mode === "create") {
					if (info) {
						return errorResult(
							`${abs} already exists. Use mode 'overwrite' (needs confirm) or 'append'.`,
						);
					}
					await bridge.write(abs, a.content, "create", a.createDirs);
					return textResult(`Created ${abs} (${bytes} bytes).`);
				}
				if (a.mode === "append") {
					await bridge.write(abs, a.content, "append", a.createDirs);
					return textResult(`Appended ${bytes} bytes to ${abs}.`);
				}
				if (!info) {
					await bridge.write(abs, a.content, "overwrite", a.createDirs);
					return textResult(`Created ${abs} (${bytes} bytes); it did not exist.`);
				}
				return withConfirm(
					a.confirm,
					async () => {
						const old = await bridge.peek(abs, 2000);
						return (
							`Would overwrite ${abs}: ${info.size} bytes -> ${bytes} bytes.\n` +
							(old === null ? "Existing file is binary.\n" : `Current start:\n${head(old)}\n`) +
							`New start:\n${head(a.content)}`
						);
					},
					async () => {
						await bridge.write(abs, a.content, "overwrite", a.createDirs);
						return textResult(`Overwrote ${abs} (${info.size} -> ${bytes} bytes).`);
					},
				);
			},
		}),

		defineTool({
			name: "create_folder",
			description: "Create a folder (and missing parents). No-op if it already exists.",
			schema: z.object({ path: pathField("Folder path") }),
			async run(a) {
				const abs = resolve(a.path, "write");
				const info = await bridge.info(abs);
				if (info && info.type !== "dir") return errorResult(`${abs} exists and is not a folder.`);
				if (info) return textResult(`${abs} already exists.`);
				await bridge.mkdir(abs);
				return textResult(`Created folder ${abs}.`);
			},
		}),

		defineTool({
			name: "move_file",
			description:
				"Move or rename a file or folder. If the destination already exists it would be " +
				"replaced, which needs confirm: true (preview first). Destination is the full new " +
				"path, not a folder to move into.",
			schema: z.object({
				from: pathField("Existing path"),
				to: pathField("New full path (including the new file name)"),
				confirm: confirmField,
			}),
			async run(a) {
				const from = resolve(a.from, "write");
				const to = resolve(a.to, "write");
				const src = await bridge.info(from);
				if (!src) return errorResult(`Not found: ${from}`);
				if (from === to) return errorResult("Source and destination are the same.");
				if (to.startsWith(`${from}/`)) {
					return errorResult("Cannot move a folder into itself.");
				}
				const dst = await bridge.info(to);
				if (dst?.type === "dir" && src.type !== "dir") {
					return errorResult(
						`${to} is an existing folder. Give the full destination path, e.g. ${to}/${src.name}.`,
					);
				}
				if (!existsSync(dirname(to))) {
					return errorResult(`Destination folder ${dirname(to)} does not exist. Use create_folder.`);
				}
				const run = async () => {
					await bridge.move(from, to);
					return textResult(`Moved ${from} -> ${to}.`);
				};
				if (!dst) return run();
				return withConfirm(
					a.confirm,
					() =>
						`Would move ${from} (${src.type}, ${src.size} bytes) onto existing ` +
						`${to} (${dst.type}, ${dst.size} bytes), replacing it.`,
					run,
				);
			},
		}),

		defineTool({
			name: "trash_file",
			description:
				"Move a file or folder to the Trash (recoverable from Finder). Always requires " +
				"confirm: true; without it you get a preview. Nothing is ever permanently deleted.",
			schema: z.object({ path: pathField("File or folder to trash"), confirm: confirmField }),
			async run(a) {
				const abs = resolve(a.path, "write");
				const info = await bridge.info(abs);
				if (!info) return errorResult(`Not found: ${abs}`);
				return withConfirm(
					a.confirm,
					() => `Would move ${info.type} ${abs} (${info.size} bytes) to the Trash.`,
					async () => {
						const where = await bridge.trash(abs);
						return textResult(`Moved ${abs} to the Trash${where ? ` (${where})` : ""}.`);
					},
				);
			},
		}),
	]);
}
