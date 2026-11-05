import { z } from "zod";
import { confirmField, withConfirm } from "../../lib/safety.js";
import { dataResult, defineTool, type ToolModule, toolModule } from "../../lib/types.js";
import { type RemindersBridge, remindersBridge } from "./bridge.js";

const isoDate = z
	.string()
	.refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 date/time")
	.describe("ISO 8601 date/time, e.g. 2026-11-06T09:00:00+01:00");

const priority = z.enum(["none", "low", "medium", "high"]);
const reminderId = z.string().min(1).describe("Reminder id as returned by list_reminders");

export function createRemindersModule(bridge: RemindersBridge = remindersBridge): ToolModule {
	return toolModule([
		defineTool({
			name: "list_reminder_lists",
			description: "List all Apple Reminders lists with their number of open reminders.",
			schema: z.object({}),
			async run() {
				const lists = await bridge.listLists();
				return dataResult(`${lists.length} reminder lists.`, lists);
			},
		}),

		defineTool({
			name: "list_reminders",
			description:
				"List or search Apple Reminders, sorted by due date (undated last). Filters " +
				"combine. By default only open (not completed) reminders are returned.",
			schema: z.object({
				list: z.string().optional().describe("Only this list (name, case-insensitive)"),
				query: z.string().optional().describe("Case-insensitive text in title or notes"),
				includeCompleted: z.boolean().default(false),
				dueBefore: isoDate.optional().describe("Only reminders due at or before this time"),
				limit: z.number().int().min(1).max(500).default(50),
			}),
			async run(args) {
				const reminders = await bridge.listReminders(args);
				const capped = reminders.length === args.limit ? ` (limit ${args.limit} reached)` : "";
				return dataResult(`${reminders.length} reminders${capped}.`, reminders);
			},
		}),

		defineTool({
			name: "create_reminder",
			description: "Create a reminder in Apple Reminders. Uses the default list if none given.",
			schema: z.object({
				name: z.string().trim().min(1).describe("Reminder title"),
				list: z.string().optional().describe("Target list name (must exist)"),
				notes: z.string().optional(),
				dueDate: isoDate.optional(),
				priority: priority.optional(),
			}),
			async run(args) {
				const r = await bridge.createReminder(args);
				return dataResult(`Created reminder "${r.name}" in "${r.list}".`, r);
			},
		}),

		defineTool({
			name: "update_reminder",
			description:
				"Change fields of an existing reminder. Only the fields given are changed; pass " +
				"null for notes or dueDate to clear them.",
			schema: z
				.object({
					id: reminderId,
					name: z.string().trim().min(1).optional(),
					notes: z.string().nullable().optional(),
					dueDate: isoDate.nullable().optional(),
					priority: priority.optional(),
				})
				.refine(
					({ id, ...rest }) => Object.values(rest).some((v) => v !== undefined),
					"provide at least one field to change",
				),
			async run({ id, ...patch }) {
				const r = await bridge.updateReminder(id, patch);
				return dataResult(`Updated reminder "${r.name}".`, r);
			},
		}),

		defineTool({
			name: "complete_reminder",
			description: "Mark a reminder as completed (or reopen it with completed: false).",
			schema: z.object({ id: reminderId, completed: z.boolean().default(true) }),
			async run({ id, completed }) {
				const r = await bridge.updateReminder(id, { completed });
				return dataResult(`${completed ? "Completed" : "Reopened"} "${r.name}".`, r);
			},
		}),

		defineTool({
			name: "delete_reminder",
			description: "Permanently delete a reminder. Requires confirm: true; otherwise previews.",
			schema: z.object({ id: reminderId, confirm: confirmField }),
			async run({ id, confirm }) {
				const r = await bridge.getReminder(id);
				return withConfirm(
					confirm,
					() => `Would delete reminder "${r.name}" from list "${r.list}".`,
					async () => {
						await bridge.deleteReminder(id);
						return dataResult(`Deleted reminder "${r.name}".`, { id, deleted: true });
					},
				);
			},
		}),
	]);
}
