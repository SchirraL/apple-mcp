import { z } from "zod";
import { confirmField, withConfirm } from "../../lib/safety.js";
import { dataResult, defineTool, type ToolModule, toolModule } from "../../lib/types.js";
import { type CalendarBridge, calendarBridge, type EventRef } from "./bridge.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// EventKit refuses event predicates spanning more than four years.
const MAX_RANGE_MS = 1461 * DAY_MS;

const isoDate = z
	.string()
	.refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 date/time")
	.describe("ISO 8601, e.g. 2026-11-06T09:00:00+01:00, or 2026-11-06 for all-day");

const eventId = z.string().min(1).describe("Event id as returned by list_calendar_events");
const occurrenceStart = isoDate
	.optional()
	.describe(
		"Picks one occurrence of a recurring event: pass the event's `start` exactly as " +
			"returned by list_calendar_events",
	);
const span = z
	.enum(["this", "future"])
	.default("this")
	.describe('"this" affects only this occurrence, "future" it and all later ones');

/** Date-only strings are local midnight (Date.parse would read them as UTC). */
function toMs(s: string): number {
	return /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00`) : Date.parse(s);
}

function makeRef(id: string, occurrence: string | undefined): EventRef {
	return occurrence === undefined ? { id } : { id, occurrenceStart: occurrence };
}

export function createCalendarModule(bridge: CalendarBridge = calendarBridge): ToolModule {
	return toolModule([
		defineTool({
			name: "list_calendars",
			effect: "read",
			description: "List all Apple Calendar calendars with their account and writability.",
			schema: z.object({}),
			async run() {
				const calendars = await bridge.listCalendars();
				return dataResult(`${calendars.length} calendars.`, calendars);
			},
		}),

		defineTool({
			name: "list_calendar_events",
			effect: "read",
			description:
				"List Apple Calendar events in a time range, sorted by start. Defaults to the " +
				"next 7 days. The range may not exceed 4 years. Recurring events appear once " +
				"per occurrence.",
			schema: z.object({
				from: isoDate.optional().describe("Range start (default: now)"),
				to: isoDate.optional().describe("Range end (default: from + 7 days)"),
				calendar: z.string().optional().describe("Only this calendar (name)"),
				query: z.string().optional().describe("Case-insensitive text in title, location or notes"),
				limit: z.number().int().min(1).max(500).default(100),
			}),
			async run(args) {
				const from = args.from ?? new Date().toISOString();
				const fromMs = toMs(from);
				const to = args.to ?? new Date(fromMs + 7 * DAY_MS).toISOString();
				const toMsValue = toMs(to);
				if (toMsValue <= fromMs) {
					throw new Error("'to' must be after 'from'.");
				}
				if (toMsValue - fromMs > MAX_RANGE_MS) {
					throw new Error("Date range too long: at most 4 years are supported. Narrow from/to.");
				}
				const events = await bridge.listEvents({
					from,
					to,
					...(args.calendar !== undefined && { calendar: args.calendar }),
					...(args.query !== undefined && { query: args.query }),
					limit: args.limit,
				});
				const capped = events.length === args.limit ? ` (limit ${args.limit} reached)` : "";
				return dataResult(`${events.length} events${capped}.`, events);
			},
		}),

		defineTool({
			name: "create_calendar_event",
			effect: "write",
			description:
				"Create an event in Apple Calendar. A date-only start (YYYY-MM-DD) creates an " +
				"all-day event; timed events default to 1 hour if no end is given. Uses the " +
				"default calendar if none is given.",
			schema: z.object({
				title: z.string().trim().min(1).describe("Event title"),
				start: isoDate,
				end: isoDate.optional(),
				allDay: z.boolean().optional(),
				calendar: z.string().optional().describe("Target calendar name (must exist)"),
				location: z.string().optional(),
				notes: z.string().optional(),
				url: z.string().url().optional(),
			}),
			async run(args) {
				if (args.end !== undefined && toMs(args.end) < toMs(args.start)) {
					throw new Error("'end' must not be before 'start'.");
				}
				const e = await bridge.createEvent(args);
				return dataResult(`Created event "${e.title}" in "${e.calendar}".`, e);
			},
		}),

		defineTool({
			name: "update_calendar_event",
			effect: "write",
			description:
				"Change fields of an existing event. Only the fields given are changed; pass " +
				"null for location, notes or url to clear them. For recurring events pass " +
				"occurrenceStart and choose span.",
			schema: z
				.object({
					id: eventId,
					occurrenceStart,
					span,
					title: z.string().trim().min(1).optional(),
					start: isoDate.optional(),
					end: isoDate.optional(),
					allDay: z.boolean().optional(),
					location: z.string().nullable().optional(),
					notes: z.string().nullable().optional(),
					url: z.string().url().nullable().optional(),
				})
				.refine(
					({ id, occurrenceStart: _o, span: _s, ...rest }) =>
						Object.values(rest).some((v) => v !== undefined),
					"provide at least one field to change",
				),
			async run({ id, occurrenceStart: occurrence, span: s, ...patch }) {
				const e = await bridge.updateEvent(makeRef(id, occurrence), patch, s);
				return dataResult(`Updated event "${e.title}".`, e);
			},
		}),

		defineTool({
			name: "delete_calendar_event",
			effect: "write",
			description:
				"Permanently delete a calendar event. Requires confirm: true; otherwise previews. " +
				"For recurring events pass occurrenceStart and choose span.",
			schema: z.object({
				id: eventId,
				occurrenceStart,
				span,
				confirm: confirmField,
			}),
			async run({ id, occurrenceStart: occurrence, span: s, confirm }) {
				const ref = makeRef(id, occurrence);
				const e = await bridge.getEvent(ref);
				if (e.recurring && occurrence === undefined) {
					// getEvent would describe the series' first occurrence — wrong preview.
					throw new Error(
						`"${e.title}" is recurring: pass occurrenceStart (the event's start from ` +
							"list_calendar_events) to choose which occurrence to delete.",
					);
				}
				return withConfirm(
					confirm,
					() => {
						const more = s === "future" && e.recurring ? " and all future occurrences" : "";
						return `Would delete event "${e.title}" (${e.start}) from calendar "${e.calendar}"${more}.`;
					},
					async () => {
						await bridge.deleteEvent(ref, s);
						return dataResult(`Deleted event "${e.title}".`, { id, deleted: true });
					},
				);
			},
		}),
	]);
}
