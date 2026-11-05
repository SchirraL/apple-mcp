import { runJxa } from "../../lib/applescript.js";

// EventKit via the JXA ObjC bridge (same approach as reminders/bridge.ts).

export interface CalendarInfo {
	id: string;
	name: string;
	account: string;
	writable: boolean;
}

export interface CalendarEvent {
	/** EventKit eventIdentifier. Shared by all occurrences of a recurring event. */
	id: string;
	title: string;
	calendar: string;
	/** Local ISO with offset, or YYYY-MM-DD for all-day events. */
	start: string;
	/** Local ISO with offset, or YYYY-MM-DD (last day, inclusive) for all-day events. */
	end: string;
	allDay: boolean;
	location: string | null;
	notes: string | null;
	url: string | null;
	recurring: boolean;
	attendees: string[];
}

export interface EventQuery {
	from: string;
	to: string;
	calendar?: string;
	query?: string;
	limit: number;
}

export interface NewEvent {
	title: string;
	start: string;
	end?: string;
	allDay?: boolean;
	calendar?: string;
	location?: string;
	notes?: string;
	url?: string;
}

export interface EventPatch {
	title?: string;
	start?: string;
	end?: string;
	allDay?: boolean;
	location?: string | null;
	notes?: string | null;
	url?: string | null;
}

/** Identifies one event; `occurrenceStart` picks an occurrence of a recurring event. */
export interface EventRef {
	id: string;
	occurrenceStart?: string;
}

export type Span = "this" | "future";

export interface CalendarBridge {
	listCalendars(): Promise<CalendarInfo[]>;
	listEvents(q: EventQuery): Promise<CalendarEvent[]>;
	getEvent(ref: EventRef): Promise<CalendarEvent>;
	createEvent(e: NewEvent): Promise<CalendarEvent>;
	updateEvent(ref: EventRef, patch: EventPatch, span: Span): Promise<CalendarEvent>;
	deleteEvent(ref: EventRef, span: Span): Promise<void>;
}

type Op =
	| { op: "calendars" }
	| { op: "list"; q: EventQuery }
	| { op: "get"; ref: EventRef }
	| { op: "create"; e: NewEvent }
	| { op: "update"; ref: EventRef; patch: EventPatch; span: Span }
	| { op: "delete"; ref: EventRef; span: Span };

/**
 * Runs inside osascript (JXA). Must stay fully self-contained: no imports, no outer refs.
 */
function eventKitCalendar(a: Op): unknown {
	ObjC.import("EventKit");
	const $: any = (globalThis as any).$;
	const EVENT = 0; // EKEntityTypeEvent

	const spin = (isDone: () => boolean, seconds: number) => {
		const until = $.NSDate.dateWithTimeIntervalSinceNow(seconds);
		while (!isDone() && $.NSDate.date.compare(until) < 0) {
			$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.02));
		}
	};

	const store = $.EKEventStore.alloc.init;
	// Statuses: 0 notDetermined, 1 restricted, 2 denied, 3 fullAccess, 4 writeOnly
	let status = Number($.EKEventStore.authorizationStatusForEntityType(EVENT));
	if (status === 0) {
		let answered = false;
		store.requestFullAccessToEventsWithCompletion(() => {
			answered = true;
		});
		spin(() => answered, 120);
		status = Number($.EKEventStore.authorizationStatusForEntityType(EVENT));
	}
	if (status === 4) {
		throw new Error(
			"Only write access to Calendars was granted, reading needs Full Access. Change it in " +
				"System Settings > Privacy & Security > Calendars for the app running this server.",
		);
	}
	if (status !== 3) {
		throw new Error(
			"No full access to Calendars. Enable it in System Settings > Privacy & Security > " +
				"Calendars for the app running this server, then retry.",
		);
	}

	const str = (x: any): string | null => (x && !x.isNil() && x.js ? String(x.js) : null);
	const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
	const isDateOnly = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
	// Date-only strings are local midnight (JS would parse them as UTC).
	const parse = (s: string) => (isDateOnly(s) ? new Date(`${s}T00:00:00`) : new Date(s));
	const toNs = (d: Date) => $.NSDate.dateWithTimeIntervalSince1970(d.getTime() / 1000);
	const fromNs = (ns: any) => new Date(Number(ns.timeIntervalSince1970) * 1000);
	const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	const localIso = (d: Date) => {
		const off = -d.getTimezoneOffset();
		const sign = off >= 0 ? "+" : "-";
		const abs = Math.abs(off);
		return (
			`${localDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
			`${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
		);
	};

	const toJson = (e: any) => {
		const allDay = Boolean(e.allDay);
		const start = fromNs(e.startDate);
		// All-day endDate is the last instant of the final day; step back 1s to be safe.
		const end = allDay ? new Date(fromNs(e.endDate).getTime() - 1000) : fromNs(e.endDate);
		const attendees: string[] = [];
		const att = e.attendees;
		if (att && !att.isNil()) {
			for (let i = 0; i < Number(att.count); i++) {
				const p = att.objectAtIndex(i);
				const name = str(p.name) ?? str(p.URL.resourceSpecifier);
				if (name) attendees.push(name);
			}
		}
		const url = e.URL;
		return {
			id: str(e.eventIdentifier) ?? "",
			title: str(e.title) ?? "",
			calendar: str(e.calendar.title) ?? "",
			start: allDay ? localDay(start) : localIso(start),
			end: allDay ? localDay(end) : localIso(end),
			allDay,
			location: str(e.location),
			notes: str(e.notes),
			url: url && !url.isNil() ? str(url.absoluteString) : null,
			recurring: Boolean(e.hasRecurrenceRules),
			attendees,
		};
	};

	const calendars = () => {
		const cals = store.calendarsForEntityType(EVENT);
		const out: any[] = [];
		for (let i = 0; i < Number(cals.count); i++) out.push(cals.objectAtIndex(i));
		return out;
	};

	const findCalendar = (name: string) => {
		const all = calendars();
		const hit = all.find((c) => String(c.title.js).toLowerCase() === name.toLowerCase());
		if (!hit) {
			const names = all.map((c) => c.title.js).join(", ");
			throw new Error(`No calendar named "${name}". Calendars: ${names}`);
		}
		return hit;
	};

	const events = (from: Date, to: Date, cal: any | null): any[] => {
		// JS arrays of ObjC objects don't bridge back to NSArray — build one natively.
		const cals = cal ? $.NSArray.arrayWithObject(cal) : store.calendarsForEntityType(EVENT);
		const pred = store.predicateForEventsWithStartDateEndDateCalendars(toNs(from), toNs(to), cals);
		const rs = store.eventsMatchingPredicate(pred);
		const out: any[] = [];
		if (rs && !rs.isNil()) for (let i = 0; i < Number(rs.count); i++) out.push(rs.objectAtIndex(i));
		return out;
	};

	const resolve = (ref: EventRef, forWrite = false) => {
		const first = store.eventWithIdentifier(ref.id);
		if (!first || first.isNil()) throw new Error(`No event with id ${ref.id}`);
		if (!ref.occurrenceStart) {
			// Without an occurrence EventKit hands back the series' FIRST occurrence (often in
			// the past), so a write would silently hit the wrong one — or the whole series.
			if (forWrite && first.hasRecurrenceRules) {
				throw new Error(
					`Event ${ref.id} is recurring: pass occurrenceStart (the event's start from ` +
						"list_calendar_events) to choose which occurrence to change.",
				);
			}
			return first;
		}
		const t = parse(ref.occurrenceStart).getTime();
		const hits = events(new Date(t - 86400000), new Date(t + 86400000), first.calendar);
		const match = hits.find(
			(e) => str(e.eventIdentifier) === ref.id && Math.abs(fromNs(e.startDate).getTime() - t) < 60000,
		);
		if (!match) throw new Error(`Event ${ref.id} has no occurrence at ${ref.occurrenceStart}`);
		return match;
	};

	const assertWritable = (e: any) => {
		if (!e.calendar.allowsContentModifications) {
			throw new Error(`Calendar "${str(e.calendar.title)}" is read-only`);
		}
	};

	const applyTimes = (e: any, start?: string, end?: string, allDay?: boolean) => {
		if (allDay !== undefined) e.allDay = allDay;
		const isAllDay = Boolean(e.allDay);
		if (start !== undefined) {
			const oldStart = fromNs(e.startDate).getTime();
			const oldLen = fromNs(e.endDate).getTime() - oldStart;
			const s = parse(start);
			e.startDate = toNs(s);
			// Moving the start keeps the duration unless a new end is given.
			if (end === undefined) e.endDate = toNs(new Date(s.getTime() + Math.max(oldLen, 0)));
		}
		if (end !== undefined) {
			const d = parse(end);
			// All-day end is inclusive for callers; EventKit wants a time on that final day.
			e.endDate = toNs(isAllDay && isDateOnly(end) ? new Date(d.getTime() + 43200000) : d);
		}
	};

	const setText = (e: any, key: "location" | "notes", v: string | null | undefined) => {
		if (v === undefined) return;
		e[key] = v === null ? $() : v;
	};

	const setUrl = (e: any, v: string | null | undefined) => {
		if (v === undefined) return;
		e.URL = v === null ? $() : $.NSURL.URLWithString(v);
	};

	const save = (e: any, span: number) => {
		const err = $();
		if (!store.saveEventSpanCommitError(e, span, true, err)) {
			throw new Error(`Saving event failed: ${str(err.localizedDescription) ?? "unknown"}`);
		}
	};

	const spanNum = (s: Span) => (s === "future" ? 1 : 0); // EKSpanThisEvent / FutureEvents

	switch (a.op) {
		case "calendars":
			return calendars().map((c) => ({
				id: String(c.calendarIdentifier.js),
				name: String(c.title.js),
				account: str(c.source.title) ?? "",
				writable: Boolean(c.allowsContentModifications),
			}));
		case "list": {
			const q = a.q;
			const cal = q.calendar ? findCalendar(q.calendar) : null;
			const needle = q.query ? q.query.toLowerCase() : null;
			const out = events(parse(q.from), parse(q.to), cal)
				.map(toJson)
				.filter(
					(e) =>
						!needle ||
						[e.title, e.location, e.notes].some((f) => f && f.toLowerCase().includes(needle)),
				);
			out.sort((x, y) => parse(x.start).getTime() - parse(y.start).getTime());
			return out.slice(0, q.limit);
		}
		case "get":
			return toJson(resolve(a.ref));
		case "create": {
			const n = a.e;
			const e = $.EKEvent.eventWithEventStore(store);
			e.calendar = n.calendar ? findCalendar(n.calendar) : store.defaultCalendarForNewEvents;
			assertWritable(e);
			e.title = n.title;
			const allDay = n.allDay ?? isDateOnly(n.start);
			e.allDay = allDay;
			const s = parse(n.start);
			e.startDate = toNs(s);
			// Placeholder end, then real end: default 1h, or the same day for all-day events.
			e.endDate = toNs(new Date(s.getTime() + 3600000));
			applyTimes(e, undefined, n.end ?? (allDay ? localDay(s) : undefined), undefined);
			if (n.location) e.location = n.location;
			if (n.notes) e.notes = n.notes;
			if (n.url) setUrl(e, n.url);
			save(e, 0);
			return toJson(e);
		}
		case "update": {
			const e = resolve(a.ref, true);
			assertWritable(e);
			const p = a.patch;
			if (p.title !== undefined) e.title = p.title;
			applyTimes(e, p.start, p.end, p.allDay);
			setText(e, "location", p.location);
			setText(e, "notes", p.notes);
			setUrl(e, p.url);
			save(e, spanNum(a.span));
			return toJson(e);
		}
		case "delete": {
			const e = resolve(a.ref, true);
			assertWritable(e);
			const err = $();
			if (!store.removeEventSpanCommitError(e, spanNum(a.span), true, err)) {
				throw new Error(`Deleting event failed: ${str(err.localizedDescription) ?? "unknown"}`);
			}
			return null;
		}
	}
}

const run = <R>(op: Op): Promise<R> =>
	runJxa(eventKitCalendar, op, { app: "Calendar" }) as Promise<R>;

export const calendarBridge: CalendarBridge = {
	listCalendars: () => run({ op: "calendars" }),
	listEvents: (q) => run({ op: "list", q }),
	getEvent: (ref) => run({ op: "get", ref }),
	createEvent: (e) => run({ op: "create", e }),
	updateEvent: (ref, patch, span) => run({ op: "update", ref, patch, span }),
	deleteEvent: (ref, span) => run<null>({ op: "delete", ref, span }).then(() => undefined),
};
