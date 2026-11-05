import { z } from "zod";
import { confirmField, withConfirm } from "../../lib/safety.js";
import { dataResult, defineTool, type ToolModule, toolModule } from "../../lib/types.js";
import { type Note, type NotePatch, type NotesBridge, notesBridge } from "./bridge.js";

const noteId = z.string().min(1).describe("Note id as returned by list_notes");
const format = z
	.enum(["text", "html"])
	.default("text")
	.describe('"text" is converted line by line, "html" is used as Notes HTML');

const LOCKED_MSG = (n: Note): string =>
	`Note "${n.title}" is locked (password-protected) and cannot be modified via this server.`;

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function createNotesModule(bridge: NotesBridge = notesBridge): ToolModule {
	return toolModule([
		defineTool({
			name: "list_note_folders",
			description: "List all Apple Notes folders with their account and note count.",
			schema: z.object({}),
			async run() {
				const folders = await bridge.listFolders();
				return dataResult(`${folders.length} folders.`, folders);
			},
		}),

		defineTool({
			name: "list_notes",
			description:
				"List Apple Notes, sorted by last modified, newest first. Returns snippets only; " +
				"use read_note for the full text.",
			schema: z.object({
				folder: z
					.string()
					.optional()
					.describe('Only this folder: name, or "Account/Folder" if ambiguous'),
				query: z.string().optional().describe("Case-insensitive text in title or body"),
				limit: z.number().int().min(1).max(200).default(30),
			}),
			async run(args) {
				const notes = await bridge.listNotes({
					...(args.folder !== undefined && { folder: args.folder }),
					...(args.query !== undefined && { query: args.query }),
					limit: args.limit,
				});
				const capped = notes.length === args.limit ? ` (limit ${args.limit} reached)` : "";
				return dataResult(`${notes.length} notes${capped}.`, notes);
			},
		}),

		defineTool({
			name: "read_note",
			description:
				"Read one Apple Note in full (plain text, optionally raw HTML). Locked " +
				"(password-protected) notes return no text.",
			schema: z.object({
				id: noteId,
				includeHtml: z.boolean().default(false).describe("Also return the raw Notes HTML"),
			}),
			async run({ id, includeHtml }) {
				const note = await bridge.getNote(id, includeHtml);
				return dataResult(`Note "${note.title}" in "${note.folder}".`, note);
			},
		}),

		defineTool({
			name: "create_note",
			description:
				"Create an Apple Note. With format text the body is converted line by line; the " +
				"title becomes the note's heading. Uses the default folder if none is given.",
			schema: z.object({
				title: z.string().trim().min(1).describe("Note title (first line, as heading)"),
				body: z.string().optional().describe("Note content below the title"),
				format,
				folder: z.string().optional().describe('Folder name, or "Account/Folder"'),
			}),
			async run(args) {
				const n = await bridge.createNote({
					title: args.title,
					...(args.body !== undefined && { body: args.body }),
					format: args.format,
					...(args.folder !== undefined && { folder: args.folder }),
				});
				return dataResult(`Created note "${n.title}" in "${n.folder}".`, n);
			},
		}),

		defineTool({
			name: "update_note",
			description:
				"Change an existing note. title renames it, body REPLACES everything below the " +
				"title, append adds to the end (body and append are mutually exclusive). Requires " +
				"confirm: true (otherwise previews) when replacing the body or when the note has " +
				"attachments or is shared; renaming or appending to a plain note applies directly.",
			schema: z
				.object({
					id: noteId,
					title: z.string().trim().min(1).optional().describe("New title"),
					body: z.string().optional().describe("Replaces everything below the title"),
					append: z.string().optional().describe("Text added to the end of the note"),
					format,
					confirm: confirmField,
				})
				.refine(
					(a) => a.title !== undefined || a.body !== undefined || a.append !== undefined,
					"provide at least one of title, body or append",
				)
				.refine(
					(a) => !(a.body !== undefined && a.append !== undefined),
					"body and append cannot be combined: use one or the other",
				),
			async run({ id, title, body, append, format: fmt, confirm }) {
				const note = await bridge.getNote(id, false);
				if (note.locked) {
					throw new Error(LOCKED_MSG(note));
				}
				const patch: NotePatch = {
					...(title !== undefined && { title }),
					...(body !== undefined && { body }),
					...(append !== undefined && { append }),
					format: fmt,
				};
				const apply = async () => {
					const n = await bridge.updateNote(id, patch);
					return dataResult(`Updated note "${n.title}".`, n);
				};

				const attachments = note.attachments.length;
				if (body === undefined && attachments === 0 && !note.shared) {
					return apply();
				}
				return withConfirm(confirm, () => {
					const actions: string[] = [];
					if (title !== undefined) actions.push(`rename to "${title}"`);
					if (body !== undefined) actions.push("replace the body (everything below the title)");
					if (append !== undefined) {
						actions.push(`append ${plural(append.length, "character")} to the end`);
					}
					const lines = [
						`Would update note "${note.title}" in folder "${note.folder}": ${actions.join("; ")}.`,
					];
					if (attachments > 0) {
						lines.push(`Warning: it has ${plural(attachments, "attachment")} that may be lost.`);
					}
					if (note.shared) {
						lines.push("Warning: it is shared with other people, who will see the change.");
					}
					return lines.join("\n");
				}, apply);
			},
		}),

		defineTool({
			name: "delete_note",
			description:
				'Delete a note (moves it to "Recently Deleted"). Requires confirm: true; ' +
				"otherwise previews.",
			schema: z.object({ id: noteId, confirm: confirmField }),
			async run({ id, confirm }) {
				const note = await bridge.getNote(id, false);
				if (note.locked) {
					throw new Error(LOCKED_MSG(note));
				}
				return withConfirm(
					confirm,
					() => {
						const lines = [
							`Would delete note "${note.title}" from folder "${note.folder}". ` +
								'It moves to "Recently Deleted".',
						];
						if (note.shared) {
							lines.push("Warning: it is shared with other people.");
						}
						if (note.attachments.length > 0) {
							lines.push(`Warning: it has ${plural(note.attachments.length, "attachment")}.`);
						}
						return lines.join("\n");
					},
					async () => {
						await bridge.deleteNote(id);
						return dataResult(`Moved note "${note.title}" to Recently Deleted.`, {
							id,
							deleted: true,
						});
					},
				);
			},
		}),
	]);
}
