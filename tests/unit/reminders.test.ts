import { beforeEach, describe, expect, test } from "bun:test";
import { OsaError } from "../../src/lib/applescript.js";
import type { ToolModule } from "../../src/lib/types.js";
import { createRemindersModule } from "../../src/tools/reminders/handler.js";
import type {
	ListQuery,
	NewReminder,
	Reminder,
	ReminderPatch,
	RemindersBridge,
} from "../../src/tools/reminders/bridge.js";

const sample: Reminder = {
	id: "r1",
	name: "Buy milk",
	notes: null,
	list: "Groceries",
	completed: false,
	dueDate: null,
	priority: "none",
};

class FakeBridge implements RemindersBridge {
	calls: { method: string; args: unknown[] }[] = [];
	error: Error | null = null;

	private record(method: string, ...args: unknown[]): void {
		this.calls.push({ method, args });
		if (this.error) throw this.error;
	}

	callsOf(method: string): unknown[][] {
		return this.calls.filter((c) => c.method === method).map((c) => c.args);
	}

	async listLists() {
		this.record("listLists");
		return [{ id: "l1", name: "Groceries", openCount: 2 }];
	}
	async listReminders(q: ListQuery) {
		this.record("listReminders", q);
		return [sample];
	}
	async getReminder(id: string) {
		this.record("getReminder", id);
		return { ...sample, id };
	}
	async createReminder(r: NewReminder) {
		this.record("createReminder", r);
		return { ...sample, name: r.name, list: r.list ?? "Default" };
	}
	async updateReminder(id: string, patch: ReminderPatch) {
		this.record("updateReminder", id, patch);
		return { ...sample, id };
	}
	async deleteReminder(id: string) {
		this.record("deleteReminder", id);
	}
}

function text(res: { content: unknown }): string {
	return (res.content as { text: string }[]).map((c) => c.text).join("\n");
}

let bridge: FakeBridge;
let mod: ToolModule;

beforeEach(() => {
	bridge = new FakeBridge();
	mod = createRemindersModule(bridge);
});

describe("tools list", () => {
	test("exposes exactly the expected tools", () => {
		expect(mod.tools.map((t) => t.name).sort()).toEqual(
			[
				"complete_reminder",
				"create_reminder",
				"delete_reminder",
				"list_reminder_lists",
				"list_reminders",
				"update_reminder",
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

describe("list_reminder_lists", () => {
	test("returns lists", async () => {
		const res = await mod.handle("list_reminder_lists", {});
		expect(res.isError).toBeUndefined();
		expect(text(res)).toContain("1 reminder lists");
		expect(text(res)).toContain("Groceries");
	});
});

describe("list_reminders", () => {
	test("applies defaults", async () => {
		const res = await mod.handle("list_reminders", {});
		expect(res.isError).toBeUndefined();
		expect(bridge.callsOf("listReminders")[0]![0]).toEqual({
			includeCompleted: false,
			limit: 50,
		});
	});

	test("passes filters through", async () => {
		await mod.handle("list_reminders", {
			list: "Work",
			query: "x",
			includeCompleted: true,
			dueBefore: "2026-11-06T09:00:00+01:00",
			limit: 5,
		});
		expect(bridge.callsOf("listReminders")[0]![0]).toEqual({
			list: "Work",
			query: "x",
			includeCompleted: true,
			dueBefore: "2026-11-06T09:00:00+01:00",
			limit: 5,
		});
	});

	test("rejects limit 0 and 501", async () => {
		for (const limit of [0, 501]) {
			const res = await mod.handle("list_reminders", { limit });
			expect(res.isError).toBe(true);
		}
		expect(bridge.calls).toHaveLength(0);
	});

	test("rejects invalid dueBefore", async () => {
		const res = await mod.handle("list_reminders", { dueBefore: "not a date" });
		expect(res.isError).toBe(true);
		expect(text(res)).toContain("dueBefore");
		expect(bridge.calls).toHaveLength(0);
	});

	test("notes when limit reached", async () => {
		const res = await mod.handle("list_reminders", { limit: 1 });
		expect(text(res)).toContain("limit 1 reached");
	});
});

describe("create_reminder", () => {
	test("rejects empty and whitespace name", async () => {
		for (const name of ["", "   "]) {
			const res = await mod.handle("create_reminder", { name });
			expect(res.isError).toBe(true);
		}
		expect(bridge.calls).toHaveLength(0);
	});

	test("passes fields through", async () => {
		const args = {
			name: "Call Bob",
			list: "Work",
			notes: "re: contract",
			dueDate: "2026-11-06T09:00:00+01:00",
			priority: "high",
		};
		const res = await mod.handle("create_reminder", args);
		expect(res.isError).toBeUndefined();
		expect(bridge.callsOf("createReminder")[0]![0]).toEqual(args);
		expect(text(res)).toContain('Created reminder "Call Bob" in "Work"');
	});

	test("trims name", async () => {
		await mod.handle("create_reminder", { name: "  hi  " });
		expect(bridge.callsOf("createReminder")[0]![0]).toEqual({ name: "hi" });
	});

	test("rejects invalid priority", async () => {
		const res = await mod.handle("create_reminder", { name: "a", priority: "urgent" });
		expect(res.isError).toBe(true);
	});
});

describe("update_reminder", () => {
	test("rejects when only id given", async () => {
		const res = await mod.handle("update_reminder", { id: "r1" });
		expect(res.isError).toBe(true);
		expect(text(res)).toContain("at least one field");
		expect(bridge.calls).toHaveLength(0);
	});

	test("rejects missing/empty id", async () => {
		expect((await mod.handle("update_reminder", { name: "x" })).isError).toBe(true);
		expect((await mod.handle("update_reminder", { id: "", name: "x" })).isError).toBe(true);
	});

	test("null notes and dueDate pass through as null; id not in patch", async () => {
		const res = await mod.handle("update_reminder", { id: "r1", notes: null, dueDate: null });
		expect(res.isError).toBeUndefined();
		const [id, patch] = bridge.callsOf("updateReminder")[0]!;
		expect(id).toBe("r1");
		expect(patch).toEqual({ notes: null, dueDate: null });
		expect("id" in (patch as object)).toBe(false);
	});

	test("only given fields are in patch", async () => {
		await mod.handle("update_reminder", { id: "r1", priority: "low" });
		expect(bridge.callsOf("updateReminder")[0]![1]).toEqual({ priority: "low" });
	});
});

describe("complete_reminder", () => {
	test("defaults completed to true", async () => {
		const res = await mod.handle("complete_reminder", { id: "r1" });
		expect(bridge.callsOf("updateReminder")[0]).toEqual(["r1", { completed: true }]);
		expect(text(res)).toContain("Completed");
	});

	test("completed:false reopens", async () => {
		const res = await mod.handle("complete_reminder", { id: "r1", completed: false });
		expect(bridge.callsOf("updateReminder")[0]).toEqual(["r1", { completed: false }]);
		expect(text(res)).toContain("Reopened");
	});
});

describe("delete_reminder", () => {
	test("without confirm previews and does not delete", async () => {
		const res = await mod.handle("delete_reminder", { id: "r1" });
		expect(res.isError).toBeUndefined();
		expect(text(res)).toContain("PREVIEW");
		expect(text(res)).toContain("Buy milk");
		expect(bridge.callsOf("deleteReminder")).toHaveLength(0);
	});

	test("confirm:false still previews", async () => {
		const res = await mod.handle("delete_reminder", { id: "r1", confirm: false });
		expect(text(res)).toContain("PREVIEW");
		expect(bridge.callsOf("deleteReminder")).toHaveLength(0);
	});

	test("confirm:true deletes by id", async () => {
		const res = await mod.handle("delete_reminder", { id: "r1", confirm: true });
		expect(res.isError).toBeUndefined();
		expect(text(res)).not.toContain("PREVIEW");
		expect(bridge.callsOf("deleteReminder")).toEqual([["r1"]]);
	});
});

describe("error handling", () => {
	test("bridge Error becomes isError result with message", async () => {
		bridge.error = new Error("boom from bridge");
		const origErr = console.error;
		console.error = () => {};
		try {
			const res = await mod.handle("list_reminder_lists", {});
			expect(res.isError).toBe(true);
			expect(text(res)).toContain("boom from bridge");
		} finally {
			console.error = origErr;
		}
	});

	test("OsaError maps to isError with its message", async () => {
		bridge.error = new OsaError("Reminders not permitted", "permission");
		const res = await mod.handle("list_reminder_lists", {});
		expect(res.isError).toBe(true);
		expect(text(res)).toContain("Reminders not permitted");
	});

	test("unknown tool name is an error", async () => {
		const res = await mod.handle("nope", {});
		expect(res.isError).toBe(true);
		expect(text(res)).toContain("Unknown tool");
	});

	test("undefined args are treated as empty object", async () => {
		const res = await mod.handle("list_reminder_lists", undefined);
		expect(res.isError).toBeUndefined();
	});
});
