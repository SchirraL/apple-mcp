import { runJxa } from "../../lib/applescript.js";

// Implemented with EventKit via the JXA ObjC bridge. The Reminders scripting dictionary is
// unusably slow (46s to read one 500-item list); EventKit answers in ~0.2s.

// EventKit priority scale: 0 none, 1-4 high, 5 medium, 6-9 low.
export type Priority = "none" | "low" | "medium" | "high";

export interface ReminderList {
	id: string;
	name: string;
	openCount: number;
}

export interface Reminder {
	id: string;
	name: string;
	notes: string | null;
	list: string;
	completed: boolean;
	/** ISO timestamp, or YYYY-MM-DD for all-day reminders. */
	dueDate: string | null;
	priority: Priority;
}

export interface ListQuery {
	list?: string;
	query?: string;
	includeCompleted: boolean;
	dueBefore?: string;
	limit: number;
}

export interface NewReminder {
	name: string;
	list?: string;
	notes?: string;
	dueDate?: string;
	priority?: Priority;
}

export interface ReminderPatch {
	name?: string;
	notes?: string | null;
	dueDate?: string | null;
	priority?: Priority;
	completed?: boolean;
}

export interface RemindersBridge {
	listLists(): Promise<ReminderList[]>;
	listReminders(q: ListQuery): Promise<Reminder[]>;
	getReminder(id: string): Promise<Reminder>;
	createReminder(r: NewReminder): Promise<Reminder>;
	updateReminder(id: string, patch: ReminderPatch): Promise<Reminder>;
	deleteReminder(id: string): Promise<void>;
}

type Op =
	| { op: "lists" }
	| { op: "list"; q: ListQuery }
	| { op: "get"; id: string }
	| { op: "create"; r: NewReminder }
	| { op: "update"; id: string; patch: ReminderPatch }
	| { op: "delete"; id: string };

/**
 * Runs inside osascript (JXA). Must stay fully self-contained: no imports, no outer refs.
 */
function eventKitReminders(a: Op): unknown {
	ObjC.import("EventKit");
	const $: any = (globalThis as any).$;

	const spin = (isDone: () => boolean, seconds: number) => {
		const until = $.NSDate.dateWithTimeIntervalSinceNow(seconds);
		while (!isDone() && $.NSDate.date.compare(until) < 0) {
			$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.02));
		}
	};

	const store = $.EKEventStore.alloc.init;
	// Statuses: 0 notDetermined, 1 restricted, 2 denied, 3 fullAccess, 4 writeOnly
	let status = Number($.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeReminder));
	if (status === 0) {
		let answered = false;
		store.requestFullAccessToRemindersWithCompletion(() => {
			answered = true;
		});
		spin(() => answered, 120);
		status = Number($.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeReminder));
	}
	if (status === 4) {
		throw new Error(
			"Only write access to Reminders was granted, reading needs Full Access. Change it in " +
				"System Settings > Privacy & Security > Reminders for the app running this server.",
		);
	}
	if (status !== 3) {
		throw new Error(
			"No full access to Reminders. Enable it in System Settings > Privacy & Security > " +
				"Reminders for the app running this server, then retry.",
		);
	}

	const str = (x: any): string | null => (x && !x.isNil() && x.js ? String(x.js) : null);
	const prio = (p: number) => (p === 0 ? "none" : p <= 4 ? "high" : p === 5 ? "medium" : "low");
	const prioNum: Record<string, number> = { none: 0, high: 1, medium: 5, low: 9 };
	const pad = (n: number) => (n < 10 ? `0${n}` : String(n));

	const dueOf = (r: any): string | null => {
		const c = r.dueDateComponents;
		if (!c || c.isNil()) return null;
		const d = $.NSCalendar.currentCalendar.dateFromComponents(c);
		if (!d || d.isNil()) return null;
		// NSDateComponentUndefined is NSIntegerMax; hour unset → all-day reminder.
		if (Number(c.hour) > 1e9) {
			return `${Number(c.year)}-${pad(Number(c.month))}-${pad(Number(c.day))}`;
		}
		return new Date(Number(d.timeIntervalSince1970) * 1000).toISOString();
	};

	const setDue = (r: any, iso: string | null | undefined) => {
		if (iso === undefined) return;
		if (iso === null) {
			r.dueDateComponents = $();
			return;
		}
		const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
		const ms = dateOnly ? new Date(`${iso}T00:00:00`).getTime() : new Date(iso).getTime();
		const nsDate = $.NSDate.dateWithTimeIntervalSince1970(ms / 1000);
		// year|month|day = 4|8|16; + hour|minute = 32|64
		const units = dateOnly ? 28 : 124;
		r.dueDateComponents = $.NSCalendar.currentCalendar.componentsFromDate(units, nsDate);
	};

	const toJson = (r: any) => ({
		id: str(r.calendarItemIdentifier),
		name: str(r.title) ?? "",
		notes: str(r.notes),
		list: str(r.calendar.title) ?? "",
		completed: Boolean(r.completed),
		dueDate: dueOf(r),
		priority: prio(Number(r.priority)),
	});

	const calendars = () => {
		const cals = store.calendarsForEntityType($.EKEntityTypeReminder);
		const out: any[] = [];
		for (let i = 0; i < Number(cals.count); i++) out.push(cals.objectAtIndex(i));
		return out;
	};

	const findList = (name: string) => {
		const all = calendars();
		const hit = all.find((c) => String(c.title.js).toLowerCase() === name.toLowerCase());
		if (!hit) {
			const names = all.map((c) => c.title.js).join(", ");
			throw new Error(`No reminder list named "${name}". Lists: ${names}`);
		}
		return hit;
	};

	const fetch = (cals: any[] | null, includeCompleted: boolean): any[] => {
		// JS arrays of ObjC objects don't bridge back to NSArray — build one natively.
		const arr = cals
			? $.NSArray.arrayWithObject(cals[0])
			: store.calendarsForEntityType($.EKEntityTypeReminder);
		const pred = includeCompleted
			? store.predicateForRemindersInCalendars(arr)
			: store.predicateForIncompleteRemindersWithDueDateStartingEndingCalendars($(), $(), arr);
		let result: any[] | null = null;
		store.fetchRemindersMatchingPredicateCompletion(pred, (rs: any) => {
			const items: any[] = [];
			if (rs && !rs.isNil()) {
				for (let i = 0; i < Number(rs.count); i++) items.push(rs.objectAtIndex(i));
			}
			result = items;
		});
		spin(() => result !== null, 30);
		if (result === null) throw new Error("Timed out fetching reminders from EventKit");
		return result;
	};

	const byId = (id: string) => {
		const r = store.calendarItemWithIdentifier(id);
		if (!r || r.isNil() || !r.isKindOfClass($.EKReminder)) {
			throw new Error(`No reminder with id ${id}`);
		}
		return r;
	};

	const save = (r: any) => {
		const err = $();
		if (!store.saveReminderCommitError(r, true, err)) {
			throw new Error(`Saving reminder failed: ${str(err.localizedDescription) ?? "unknown"}`);
		}
	};

	switch (a.op) {
		case "lists": {
			const cals = calendars();
			const counts: Record<string, number> = {};
			for (const r of fetch(null, false)) {
				const id = String(r.calendar.calendarIdentifier.js);
				counts[id] = (counts[id] ?? 0) + 1;
			}
			return cals.map((c) => {
				const id = String(c.calendarIdentifier.js);
				return { id, name: String(c.title.js), openCount: counts[id] ?? 0 };
			});
		}
		case "list": {
			const q = a.q;
			const cals = q.list ? [findList(q.list)] : null;
			const needle = q.query ? q.query.toLowerCase() : null;
			const cutoff = q.dueBefore ? new Date(q.dueBefore).getTime() : null;
			const out = fetch(cals, q.includeCompleted)
				.map(toJson)
				.filter((r) => {
					if (
						needle &&
						!r.name.toLowerCase().includes(needle) &&
						!(r.notes && r.notes.toLowerCase().includes(needle))
					) {
						return false;
					}
					if (cutoff !== null) {
						if (!r.dueDate) return false;
						const t = /^\d{4}-\d{2}-\d{2}$/.test(r.dueDate)
							? new Date(`${r.dueDate}T00:00:00`).getTime()
							: new Date(r.dueDate).getTime();
						if (t > cutoff) return false;
					}
					return true;
				});
			out.sort((x, y) => {
				if (x.dueDate === y.dueDate) return 0;
				if (!x.dueDate) return 1;
				if (!y.dueDate) return -1;
				return x.dueDate < y.dueDate ? -1 : 1;
			});
			return out.slice(0, q.limit);
		}
		case "get":
			return toJson(byId(a.id));
		case "create": {
			const r = $.EKReminder.reminderWithEventStore(store);
			r.title = a.r.name;
			if (a.r.notes) r.notes = a.r.notes;
			r.calendar = a.r.list ? findList(a.r.list) : store.defaultCalendarForNewReminders;
			setDue(r, a.r.dueDate);
			if (a.r.priority) r.priority = prioNum[a.r.priority];
			save(r);
			return toJson(r);
		}
		case "update": {
			const r = byId(a.id);
			const p = a.patch;
			if (p.name !== undefined) r.title = p.name;
			if (p.notes !== undefined) r.notes = p.notes === null ? $() : p.notes;
			setDue(r, p.dueDate);
			if (p.priority !== undefined) r.priority = prioNum[p.priority];
			if (p.completed !== undefined) r.completed = p.completed;
			save(r);
			return toJson(r);
		}
		case "delete": {
			const r = byId(a.id);
			const err = $();
			if (!store.removeReminderCommitError(r, true, err)) {
				throw new Error(`Deleting reminder failed: ${str(err.localizedDescription) ?? "unknown"}`);
			}
			return null;
		}
	}
}

const run = <R>(op: Op): Promise<R> =>
	runJxa(eventKitReminders, op, { app: "Reminders" }) as Promise<R>;

export const remindersBridge: RemindersBridge = {
	listLists: () => run({ op: "lists" }),
	listReminders: (q) => run({ op: "list", q }),
	getReminder: (id) => run({ op: "get", id }),
	createReminder: (r) => run({ op: "create", r }),
	updateReminder: (id, patch) => run({ op: "update", id, patch }),
	deleteReminder: (id) => run<null>({ op: "delete", id }).then(() => undefined),
};
