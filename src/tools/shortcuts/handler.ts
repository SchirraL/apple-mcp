import { statSync } from "node:fs";
import { z } from "zod";
import { PathPolicyError, resolveAllowedPath } from "../../lib/paths.js";
import { confirmField, withConfirm } from "../../lib/safety.js";
import {
	dataResult,
	defineTool,
	textResult,
	type ToolModule,
	toolModule,
} from "../../lib/types.js";
import {
	type ShortcutInfo,
	type ShortcutsBridge,
	shortcutsBridge,
} from "./bridge.js";

const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 300;
const MAX_INLINE_INPUT = 1_000_000;
const PREVIEW_INPUT_CHARS = 500;
const ALLOW_ENV = "APPLE_MCP_SHORTCUTS_ALLOW";

const norm = (s: string): string => s.trim().toLowerCase();

function describe1(s: ShortcutInfo): string {
	return `"${s.name}" (${s.identifier}, folder: ${s.folder ?? "none"})`;
}

function closeMatches(query: string, all: ShortcutInfo[], max = 8): ShortcutInfo[] {
	const q = norm(query);
	const words = q.split(/\s+/).filter((w) => w.length > 1);
	return all
		.map((s) => {
			const n = norm(s.name);
			let score = 0;
			if (n.includes(q) || q.includes(n)) score += 10;
			for (const w of words) if (n.includes(w)) score += 3;
			return { s, score };
		})
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, max)
		.map((x) => x.s);
}

/** Resolve a name or identifier to exactly one shortcut, or throw an actionable error. */
async function resolveShortcut(bridge: ShortcutsBridge, ref: string): Promise<ShortcutInfo> {
	const { shortcuts } = await bridge.catalog();
	const q = norm(ref);
	const byId = shortcuts.find((s) => norm(s.identifier) === q);
	if (byId) return byId;
	const exact = shortcuts.filter((s) => norm(s.name) === q);
	if (exact.length === 1) return exact[0]!;
	if (exact.length > 1) {
		throw new Error(
			`"${ref}" is ambiguous: ${exact.length} shortcuts have that name. Use the identifier:\n` +
				exact.map((s) => `- ${describe1(s)}`).join("\n"),
		);
	}
	const close = closeMatches(ref, shortcuts);
	throw new Error(
		`No shortcut named "${ref}".` +
			(close.length
				? ` Close matches (retry with the exact name or identifier):\n${close
						.map((s) => `- ${describe1(s)}`)
						.join("\n")}`
				: " Use list_shortcuts to see what is available."),
	);
}

function isAllowlisted(s: ShortcutInfo, env: NodeJS.ProcessEnv): boolean {
	const entries = (env[ALLOW_ENV] ?? "")
		.split(",")
		.map(norm)
		.filter(Boolean);
	return entries.includes(norm(s.name)) || entries.includes(norm(s.identifier));
}

function readInputFile(input: string): string {
	let path: string;
	try {
		path = resolveAllowedPath(input, "read");
	} catch (e) {
		if (e instanceof PathPolicyError) throw new Error(e.message);
		throw e;
	}
	let st: ReturnType<typeof statSync>;
	try {
		st = statSync(path);
	} catch {
		throw new Error(`Input file not found: ${path}`);
	}
	if (!st.isFile()) throw new Error(`Input path is not a file: ${path}`);
	return path;
}

export function createShortcutsModule(
	bridge: ShortcutsBridge = shortcutsBridge,
	env: NodeJS.ProcessEnv = process.env,
): ToolModule {
	return toolModule([
		defineTool({
			name: "list_shortcuts",
			description:
				"List the user's Apple Shortcuts (name, identifier, folder). Optional filters: " +
				"'folder' (folder name or identifier; 'none' for shortcuts not in a folder) and " +
				"'query' (case-insensitive name substring). Set includeFolders to also return the " +
				"folder list. Use this to find the exact name/identifier before run_shortcut. " +
				"Results are cached for about 30 seconds.",
			schema: z.object({
				folder: z.string().min(1).optional().describe("Folder name/identifier, or 'none'"),
				query: z.string().min(1).optional().describe("Name substring filter"),
				limit: z.number().int().min(1).max(500).default(100).describe("Max shortcuts"),
				includeFolders: z.boolean().default(false).describe("Also return the folders"),
			}),
			async run(args) {
				const cat = await bridge.catalog();
				let list = cat.shortcuts;
				if (args.folder) {
					const f = norm(args.folder);
					if (f === "none") list = list.filter((s) => s.folder === null);
					else {
						const folder = cat.folders.find(
							(x) => norm(x.name) === f || norm(x.identifier) === f,
						);
						if (!folder) {
							throw new Error(
								`No folder "${args.folder}". Folders: ${
									cat.folders.map((x) => x.name).join(", ") || "(none)"
								}.`,
							);
						}
						list = list.filter((s) => s.folder === folder.name);
					}
				}
				if (args.query) {
					const q = norm(args.query);
					list = list.filter((s) => norm(s.name).includes(q));
				}
				const total = list.length;
				const shown = list.slice(0, args.limit);
				const summary =
					`${total} shortcut(s)` +
					(total > shown.length ? `, showing the first ${shown.length}` : "") +
					".";
				return dataResult(
					summary,
					args.includeFolders ? { folders: cat.folders, shortcuts: shown } : shown,
				);
			},
		}),

		defineTool({
			name: "run_shortcut",
			description:
				"Run an Apple Shortcut by name or identifier, optionally with text input ('input') " +
				"or a file as input ('inputPath'), and capture its output (text is returned " +
				"inline; other output types are saved to a temp file whose path and type are " +
				"returned). A shortcut can do anything the user's Shortcuts can (send messages, " +
				"change files, control devices), so this ALWAYS requires confirm: true: call " +
				"first without it to get a preview naming the exact shortcut and input, show that " +
				"to the user, then call again with confirm: true. Exception: shortcuts whose name " +
				"or identifier is listed in the server's APPLE_MCP_SHORTCUTS_ALLOW environment " +
				"variable (comma-separated, case-insensitive) run without confirmation. Unknown " +
				"or ambiguous names return an error with close matches; use list_shortcuts. " +
				"timeoutSeconds defaults to 60 (max 300); shortcuts that wait for UI interaction " +
				"will time out.",
			schema: z.object({
				name: z.string().min(1).describe("Shortcut name or identifier"),
				input: z.string().max(MAX_INLINE_INPUT).optional().describe("Text input"),
				inputPath: z
					.string()
					.min(1)
					.optional()
					.describe("File to pass as input (must be inside the allowed file roots)"),
				captureOutput: z.boolean().default(true).describe("Return the shortcut's output"),
				timeoutSeconds: z
					.number()
					.int()
					.min(1)
					.max(MAX_TIMEOUT_S)
					.default(DEFAULT_TIMEOUT_S)
					.describe("Kill the run after this many seconds (default 60, max 300)"),
				confirm: confirmField,
			}),
			async run(args) {
				if (args.input !== undefined && args.inputPath !== undefined) {
					throw new Error("Pass either 'input' or 'inputPath', not both.");
				}
				const shortcut = await resolveShortcut(bridge, args.name);
				const inputPath =
					args.inputPath !== undefined ? readInputFile(args.inputPath) : undefined;
				const allowed = isAllowlisted(shortcut, env);

				const inputDesc =
					args.input !== undefined
						? `text (${args.input.length} chars): ${
								args.input.length > PREVIEW_INPUT_CHARS
									? `${args.input.slice(0, PREVIEW_INPUT_CHARS)}...`
									: JSON.stringify(args.input)
							}`
						: inputPath !== undefined
							? `file: ${inputPath}`
							: "none";

				const perform = async () => {
					const r = await bridge.run({
						identifier: shortcut.identifier,
						inputText: args.input,
						inputPath,
						captureOutput: args.captureOutput,
						timeoutMs: args.timeoutSeconds * 1000,
					});
					if (r.timedOut) {
						throw new Error(
							`Shortcut ${describe1(shortcut)} timed out after ${args.timeoutSeconds}s and ` +
								"was stopped. It may be waiting for UI interaction or a long-running " +
								"action (it might have partly completed).",
						);
					}
					if (r.exitCode !== 0) {
						throw new Error(
							`Shortcut ${describe1(shortcut)} failed (exit ${r.exitCode}): ${
								r.stderr.trim() || "no error output"
							}`,
						);
					}
					const lines = [`Ran shortcut ${describe1(shortcut)}.`];
					const log = r.stdout.trim();
					if (log) lines.push(`CLI output: ${log}`);
					const o = r.output;
					if (!args.captureOutput) {
						// nothing to add
					} else if (!o) lines.push("The shortcut produced no output.");
					else if (o.kind === "text") {
						lines.push(
							`Output (text, ${o.chars} chars${
								o.truncated ? `, truncated to ${o.text.length}` : ""
							}):`,
							o.text,
						);
					} else {
						lines.push(
							`Output is not text: saved to ${o.path} (type ${o.type}, ${o.bytes} bytes). ` +
								"The file stays in the temp directory until cleaned up.",
						);
					}
					return textResult(lines.join("\n"));
				};

				if (allowed) return perform();
				return withConfirm(
					args.confirm,
					() =>
						`Would run shortcut ${describe1(shortcut)}\n` +
						`Input: ${inputDesc}\n` +
						`Capture output: ${args.captureOutput}; timeout: ${args.timeoutSeconds}s\n` +
						"A shortcut can have arbitrary effects (messages, files, devices).",
					perform,
				);
			},
		}),

		defineTool({
			name: "view_shortcut",
			description:
				"Open a shortcut in the Shortcuts app editor (UI side effect: launches/foregrounds " +
				"Shortcuts and shows the shortcut; it does not run it). Accepts a name or " +
				"identifier; ambiguous names return an error listing identifiers.",
			schema: z.object({ name: z.string().min(1).describe("Shortcut name or identifier") }),
			async run(args) {
				const s = await resolveShortcut(bridge, args.name);
				const dupes = (await bridge.catalog()).shortcuts.filter(
					(x) => norm(x.name) === norm(s.name),
				);
				if (dupes.length > 1) {
					throw new Error(
						`The Shortcuts CLI can only open shortcuts by name, and ${dupes.length} share ` +
							`"${s.name}", so it cannot pick the right one.`,
					);
				}
				await bridge.view(s.name);
				return textResult(`Opened ${describe1(s)} in the Shortcuts editor.`);
			},
		}),
	]);
}
