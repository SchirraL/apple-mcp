import { beforeEach, describe, expect, test } from "bun:test";
import type { ToolModule } from "../../src/lib/types.js";
import type {
	CalendarBridge,
	CalendarEvent,
	CalendarInfo,
	EventPatch,
	EventQuery,
	EventRef,
	NewEvent,
	Span,
} from "../../src/tools/calendar/bridge.js";
import { createCalendarModule } from "../../src/tools/calendar/handler.js";

const sample: CalendarEvent = {
	id: "e1",
	title: "Standup",
	calendar: "Work",
	start: "2026-11-06T09:00:00+01:00",
	end: "2026-11-06T09:15:00+01:00",
	allDay: false,
	location: null,
	notes: null,
	url: null,
	recurring: false,
	attendees: [],
};

class FakeBridge implements CalendarBridge {
	calls: { method: string; args: unknown[] }[] = [];
	error: Error | null = null;
	recurring = false;

	private record(method: string, ...args: unknown[]): void {
		this.calls.push({ method, args });
		if (this.error) throw this.error;
	}

	callsOf(method: string): unknown[][] {
		return this.calls.filter((c) => c.method === method).map((c) => c.args);
	}

	async listCalendars(): Promise<CalendarInfo[]> {
		this.record("listCalendars");
		return [{ id: "c1", name: "Work", account: "iCloud", writable: true }];
	}
	async listEvents(q: EventQuery) {
		this.record("listEvents", q);
		return [sample];
	}
	async getEvent(ref: EventRef) {
		this.record("getEvent", ref);
		return { ...sample, id: ref.id, recurring: this.recurring };
	}
	async createEvent(e: NewEvent) {
		this.record("createEvent", e);
		return { ...sample, title: e.title, calendar: e.calendar ?? "Default" };
	}
	async updateEvent(ref: EventRef, patch: EventPatch, span: Span) {
		this.record("updateEvent", ref, patch, span);
		return { ...sample, id: ref.id };
	}
	async deleteEvent(ref: EventRef, span: Span) {
		this.record("deleteEvent", ref, span);
	}
}

function text(res: { content: unknown }): string {
	return (res.content as { text: string }[]).map((c) => c.text).join("\n");
}

const DAY = 24 * 60 * 60 * 1000;

let bridge: FakeBridge;
let mod: ToolModule;

beforeEach(() => {
	bridge = new FakeBridge();
	mod = createCalendarModule(bridge);
});

describe("tools list", () => {
	test("exposes exactly the expected tools", () => {
		expect(mod.tools.map((t) => t.name).sort()).toEqual(
			[
				"create_calendar_event",
				"delete_calendar_event",
				"list_calendar_events",
				"list_calendars",
				"update_calendar_event",
			].sort(),
		);
	});

	test("inputSchema is an object schema without $schema", () => {
		for (const t of mod.tools) {
			expect(t.inputSchema.type).toBe("object");
			expect("$schema" in t.inputSchema).toBe(false);
		}
	});
});

describe("list_calendars", () => {
	test("returns calendars", async () => {
		const res = await mod.handle("list_calendars", {});
		expect(res.isError).toBeUndefined();
		expect(text(res)).toContain("1 calendars");
		expect(text(res)).toContain("iCloud");
	});
});

describe("list_calendar_events", () => {
	test("applies defaults: from=now, to=from+7d, limit 100", async () => {
		const before = Date.now();
		const res = await mod.handle("list_calendar_events", {});
		const after = Date.now();
		expect(res.isError).toBeUndefined();
		const q = bridge.callsOf("listEvents")[0]![0] as EventQuery;
		const from = Date.parse(q.from);
		expect(from).toBeGreaterThanOrEqual(before - 1000);
		expect(from).toBeLessThanOrEqual(after + 1000);
		expect(Date.parse(q.to) - from).toBe(7 * DAY);
		expect(q.limit).toBe(100);
		expect("calendar" in q).toBe(false);
		expect("query" in q).toBe(false);
	});

	test("default to is from + 7 days when only from given", async () => {
		await mod.handle("list_calendar_events", { from: "2026-11-06T00:00:00Z" });
		const q = bridge.callsOf("listEvents")[0]![0] as EventQuery;
		expect(q.from).toBe("2026-11-06T00:00:00Z");
		expect(Date.parse(q.to)).toBe(Date.parse("2026-11-13T00:00:00Z"));
	});

	test("passes explicit args through", async () => {
		const args = {
			from: "2026-11-06T00:00:00+01:00",
			to: "2026-11-08T00:00:00+01:00",
			calendar: "Work",
			query: "stand",
			limit: 5,
		};
		await mod.handle("list_calendar_events", args);
		expect(bridge.callsOf("listEvents")[0]![0]).toEqual(args);
	});

	test("rejects to <= from", async () => {
		for (const to of ["2026-11-06T00:00:00Z", "2026-11-05T00:00:00Z"]) {
			const res = await mod.handle("list_calendar_events", {
				from: "2026-11-06T00:00:00Z",
				to,
			});
			expect(res.isError).toBe(true);
			expect(text(res)).toContain("after");
		}
		expect(bridge.calls).toHaveLength(0);
	});

	test("rejects ranges over 4 years but allows exactly 4 years", async () => {
		const res = await mod.handle("list_calendar_events", {
			from: "2026-01-01",
			to: "2030-06-01",
		});
		expect(res.isError).toBe(true);
		expect(text(res)).toContain("4 years");
		expect(bridge.calls).toHaveLength(0);

		const ok = await mod.handle("list_calendar_events", { from: "2026-01-01", to: "2030-01-01" });
		expect(ok.isError).toBeUndefined();
	});

	test("rejects invalid date and bad limit", async () => {
		expect((await mod.handle("list_calendar_events", { from: "nope" })).isError).toBe(true);
		for (const limit of [0, 501]) {
			expect((await mod.handle("list_calendar_events", { limit })).isError).toBe(true);
		}
		expect(bridge.calls).toHaveLength(0);
	});
});

describe("create_calendar_event", () => {
	test("rejects empty and whitespace title", async () => {
		for (const title of ["", "   "]) {
			const res = await mod.handle("create_calendar_event", {
				title,
				start: "2026-11-06T09:00:00Z",
			});
			expect(res.isError).toBe(true);
		}
		expect(bridge.calls).toHaveLength(0);
	});

	test("rejects missing start", async () => {
		const res = await mod.handle("create_calendar_event", { title: "x" });
		expect(res.isError).toBe(true);
		expect(bridge.calls).toHaveLength(0);
	});

	test("rejects end before start", async () => {
		const res = await mod.handle("create_calendar_event", {
			title: "x",
			start: "2026-11-06T10:00:00Z",
			end: "2026-11-06T09:00:00Z",
		});
		expect(res.isError).toBe(true);
		expect(text(res)).toContain("before");
		expect(bridge.calls).toHaveLength(0);
	});

	test("rejects invalid url", async () => {
		const res = await mod.handle("create_calendar_event", {
			title: "x",
			start: "2026-11-06",
			url: "not a url",
		});
		expect(res.isError).toBe(true);
		expect(bridge.calls).toHaveLength(0);
	});

	test("passes fields through", async () => {
		const args = {
			title: "Lunch",
			start: "2026-11-06T12:00:00+01:00",
			end: "2026-11-06T13:00:00+01:00",
			allDay: false,
			calendar: "Work",
			location: "Cafe",
			notes: "bring laptop",
			url: "https://example.com/x",
		};
		const res = await mod.handle("create_calendar_event", args);
		expect(res.isError).toBeUndefined();
		expect(bridge.callsOf("createEvent")[0]![0]).toEqual(args);
		expect(text(res)).toContain('Created event "Lunch" in "Work"');
	});

	test("trims title and accepts date-only start", async () => {
		await mod.handle("create_calendar_event", { title: "  Trip  ", start: "2026-11-06" });
		expect(bridge.callsOf("createEvent")[0]![0]).toEqual({ title: "Trip", start: "2026-11-06" });
	});
});

describe("update_calendar_event", () => {
	test("rejects when no patch field given", async () => {
		const res = await mod.handle("update_calendar_event", {
			id: "e1",
			occurrenceStart: "2026-11-06T09:00:00+01:00",
			span: "future",
		});
		expect(res.isError).toBe(true);
		expect(text(res)).toContain("at least one field");
		expect(bridge.calls).toHaveLength(0);
	});

	test("rejects missing id and invalid span", async () => {
		expect((await mod.handle("update_calendar_event", { title: "x" })).isError).toBe(true);
		expect(
			(await mod.handle("update_calendar_event", { id: "e1", title: "x", span: "all" })).isError,
		).toBe(true);
	});

	test("splits ref, patch and span", async () => {
		const res = await mod.handle("update_calendar_event", {
			id: "e1",
			occurrenceStart: "2026-11-06T09:00:00+01:00",
			span: "future",
			title: "New",
			start: "2026-11-06T10:00:00+01:00",
		});
		expect(res.isError).toBeUndefined();
		expect(bridge.callsOf("updateEvent")[0]).toEqual([
			{ id: "e1", occurrenceStart: "2026-11-06T09:00:00+01:00" },
			{ title: "New", start: "2026-11-06T10:00:00+01:00" },
			"future",
		]);
	});

	test("span defaults to this; ref has no occurrenceStart key", async () => {
		await mod.handle("update_calendar_event", { id: "e1", allDay: true });
		const [ref, patch, span] = bridge.callsOf("updateEvent")[0]!;
		expect(ref).toEqual({ id: "e1" });
		expect("occurrenceStart" in (ref as object)).toBe(false);
		expect(patch).toEqual({ allDay: true });
		expect(span).toBe("this");
	});

	test("null clears pass through", async () => {
		const res = await mod.handle("update_calendar_event", {
			id: "e1",
			location: null,
			notes: null,
			url: null,
		});
		expect(res.isError).toBeUndefined();
		expect(bridge.callsOf("updateEvent")[0]![1]).toEqual({
			location: null,
			notes: null,
			url: null,
		});
	});

	test("rejects invalid url", async () => {
		const res = await mod.handle("update_calendar_event", { id: "e1", url: "bad" });
		expect(res.isError).toBe(true);
	});
});

describe("delete_calendar_event", () => {
	test("without confirm previews and does not delete", async () => {
		const res = await mod.handle("delete_calendar_event", { id: "e1" });
		expect(res.isError).toBeUndefined();
		expect(text(res)).toContain("PREVIEW");
		expect(text(res)).toContain("Standup");
		expect(text(res)).toContain("Work");
		expect(text(res)).not.toContain("future occurrences");
		expect(bridge.callsOf("getEvent")).toHaveLength(1);
		expect(bridge.callsOf("deleteEvent")).toHaveLength(0);
	});

	test("confirm:false still previews", async () => {
		const res = await mod.handle("delete_calendar_event", { id: "e1", confirm: false });
		expect(text(res)).toContain("PREVIEW");
		expect(bridge.callsOf("deleteEvent")).toHaveLength(0);
	});

	test("preview mentions future occurrences for span future + recurring", async () => {
		bridge.recurring = true;
		const res = await mod.handle("delete_calendar_event", {
			id: "e1",
			occurrenceStart: "2026-11-06T09:00:00+01:00", span: "future",
		});
		expect(text(res)).toContain("PREVIEW");
		expect(text(res)).toContain("and all future occurrences");
		expect(bridge.callsOf("deleteEvent")).toHaveLength(0);
	});

	test("no future mention when span this or event not recurring", async () => {
		bridge.recurring = true;
		const thisOnly = await mod.handle("delete_calendar_event", {
			id: "e1",
			occurrenceStart: "2026-11-06T09:00:00+01:00",
		});
		expect(text(thisOnly)).not.toContain("future");
		bridge.recurring = false;
		const res = await mod.handle("delete_calendar_event", { id: "e1", span: "future" });
		expect(text(res)).not.toContain("future");
	});

	test("recurring event without occurrenceStart is rejected, nothing deleted", async () => {
		bridge.recurring = true;
		const res = await mod.handle("delete_calendar_event", { id: "e1", confirm: true });
		expect(res.isError).toBe(true);
		expect(text(res)).toContain("occurrenceStart");
		expect(bridge.callsOf("deleteEvent")).toHaveLength(0);
	});

	test("confirm:true deletes with ref and span", async () => {
		const res = await mod.handle("delete_calendar_event", {
			id: "e1",
			occurrenceStart: "2026-11-06T09:00:00+01:00",
			span: "future",
			confirm: true,
		});
		expect(res.isError).toBeUndefined();
		expect(text(res)).not.toContain("PREVIEW");
		expect(bridge.callsOf("deleteEvent")).toEqual([
			[{ id: "e1", occurrenceStart: "2026-11-06T09:00:00+01:00" }, "future"],
		]);
	});

	test("confirm:true defaults span to this", async () => {
		await mod.handle("delete_calendar_event", { id: "e1", confirm: true });
		expect(bridge.callsOf("deleteEvent")).toEqual([[{ id: "e1" }, "this"]]);
	});
});

describe("error handling", () => {
	test("bridge Error becomes isError result with message", async () => {
		bridge.error = new Error("boom from bridge");
		const origErr = console.error;
		console.error = () => {};
		try {
			const res = await mod.handle("list_calendars", {});
			expect(res.isError).toBe(true);
			expect(text(res)).toContain("boom from bridge");
		} finally {
			console.error = origErr;
		}
	});
});
