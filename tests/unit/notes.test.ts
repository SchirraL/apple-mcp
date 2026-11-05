import { beforeEach, describe, expect, test } from "bun:test";
import type { ToolModule } from "../../src/lib/types.js";
import type {
	NewNote,
	Note,
	NoteFolder,
	NotePatch,
	NoteQuery,
	NotesBridge,
	NoteSummary,
} from "../../src/tools/notes/bridge.js";
import { createNotesModule } from "../../src/tools/notes/handler.js";

const sample: Note = {
	id: "n1",
	title: "Groceries",
	folder: "Home",
	account: "iCloud",
	modified: "2026-11-05T10:00:00.000Z",
	created: "2026-11-01T10:00:00.000Z",
	locked: false,
	snippet: "milk",
	text: "Groceries\nmilk",
	html: null,
	shared: false,
	attachments: [],
};

class FakeBridge implements NotesBridge {
	calls: { method: string; args: unknown[] }[] = [];
	error: Error | null = null;
	note: Note = { ...sample };

	private record(method: string, ...args: unknown[]): void {
		this.calls.push({ method, args });
		if (this.error) throw this.error;
	}

	callsOf(method: string): unknown[][] {
		return this.calls.filter((c) => c.method === method).map((c) => c.args);
	}

	async listFolders(): Promise<NoteFolder[]> {
		this.record("listFolders");
		return [{ id: "f1", name: "Home", account: "iCloud", noteCount: 3 }];
	}
	async listNotes(q: NoteQuery): Promise<NoteSummary[]> {
		this.record("listNotes", q);
		return [sample];
	}
	async getNote(id: string, includeHtml: boolean): Promise<Note> {
		this.record("getNote", id, includeHtml);
		return { ...this.note, id };
	}
	async createNote(n: NewNote): Promise<Note> {
		this.record("createNote", n);
		return { ...sample, title: n.title, folder: n.folder ?? "Notes" };
	}
	async updateNote(id: string, patch: NotePatch): Promise<Note> {
		this.record("updateNote", id, patch);
		return { ...sample, id, title: patch.title ?? sample.title };
	}
	async deleteNote(id: string): Promise<void> {
		this.record("deleteNote", id);
	}
}

function text(res: { content: unknown }): string {
	return (res.content as { text: string }[]).map((c) => c.text).join("\n");
}

let bridge: FakeBridge;
let mod: ToolModule;

beforeEach(() => {
	bridge = new FakeBridge();
	mod = createNotesModule(bridge);
});

describe("tools list", () => {
	test("exposes exactly the expected tools", () => {
		expect(mod.tools.map((t) => t.name).sort()).toEqual(
			[
				"create_note",
				"delete_note",
				"list_note_folders",
				"list_notes",
				"read_note",
				"update_note",
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

describe("list_note_folders", () => {
	test("returns folders", async () => {
		const res = await mod.handle("list_note_folders", {});
		expect(res.isError).toBeUndefined();
		expect(text(res)).toContain("1 folders");
		expect(text(res)).toContain("iCloud");
	});
});

describe("list_notes", () => {
	test("defaults to limit 30 and omits folder/query", async () => {
		const res = await mod.handle("list_notes", {});
		expect(res.isError).toBeUndefined();
		const q = bridge.callsOf("listNotes")[0]![0] as NoteQuery;
		expect(q).toEqual({ limit: 30 });
		expect("folder" in q).toBe(false);
		expect("query" in q).toBe(false);
	});

	test("passes explicit args through", async () => {
		const args = { folder: "iCloud/Home", query: "milk", limit: 5 };
		await mod.handle("list_notes", args);
		expect(bridge.callsOf("listNotes")[0]![0]).toEqual(args);
	});

	test("limit bounds", async () => {
		for (const limit of [0, 201, 1.5]) {
			expect((await mod.handle("list_notes", { limit })).isError).toBe(true);
		}
		expect(bridge.calls).toHaveLength(0);
		for (const limit of [1, 200]) {
			expect((await mod.handle("list_notes", { limit })).isError).toBeUndefined();
		}
	});
});

describe("read_note", () => {
	test("includeHtml defaults to false", async () => {
		const res = await mod.handle("read_note", { id: "n1" });
		expect(res.isError).toBeUndefined();
		expect(bridge.callsOf("getNote")).toEqual([["n1", false]]);
		expect(text(res)).toContain("Groceries");
	});

	test("includeHtml true passes through", async () => {
		await mod.handle("read_note", { id: "n1", includeHtml: true });
		expect(bridge.callsOf("getNote")).toEqual([["n1", true]]);
	});

	test("rejects missing id", async () => {
		expect((await mod.handle("read_note", {})).isError).toBe(true);
		expect(bridge.calls).toHaveLength(0);
	});
});

describe("create_note", () => {
	test("rejects empty and whitespace title", async () => {
		for (const title of ["", "   "]) {
			expect((await mod.handle("create_note", { title })).isError).toBe(true);
		}
		expect(bridge.calls).toHaveLength(0);
	});

	test("title only: format defaults to text, no extra keys", async () => {
		const res = await mod.handle("create_note", { title: "  Hi  " });
		expect(res.isError).toBeUndefined();
		const n = bridge.callsOf("createNote")[0]![0] as NewNote;
		expect(n).toEqual({ title: "Hi", format: "text" });
		expect("body" in n).toBe(false);
		expect("folder" in n).toBe(false);
	});

	test("passes fields through without confirm", async () => {
		const args = { title: "T", body: "<b>x</b>", format: "html", folder: "Work" };
		const res = await mod.handle("create_note", args);
		expect(res.isError).toBeUndefined();
		expect(text(res)).not.toContain("PREVIEW");
		expect(bridge.callsOf("createNote")[0]![0]).toEqual(args);
		expect(text(res)).toContain('Created note "T" in "Work"');
	});

	test("rejects invalid format", async () => {
		const res = await mod.handle("create_note", { title: "T", format: "markdown" });
		expect(res.isError).toBe(true);
		expect(bridge.calls).toHaveLength(0);
	});
});

describe("update_note validation", () => {
	test("rejects when nothing to change", async () => {
		const res = await mod.handle("update_note", { id: "n1" });
		expect(res.isError).toBe(true);
		expect(text(res)).toContain("at least one");
		expect(bridge.calls).toHaveLength(0);
	});

	test("rejects body and append together", async () => {
		const res = await mod.handle("update_note", { id: "n1", body: "a", append: "b" });
		expect(res.isError).toBe(true);
		expect(text(res)).toContain("cannot be combined");
		expect(bridge.calls).toHaveLength(0);
	});

	test("rejects missing id and blank title", async () => {
		expect((await mod.handle("update_note", { title: "x" })).isError).toBe(true);
		expect((await mod.handle("update_note", { id: "n1", title: "  " })).isError).toBe(true);
		expect(bridge.calls).toHaveLength(0);
	});
});

describe("update_note behaviour", () => {
	test("locked note: error, never writes (even with confirm)", async () => {
		bridge.note = { ...sample, locked: true, text: null };
		for (const confirm of [undefined, true]) {
			const res = await mod.handle("update_note", { id: "n1", title: "x", confirm });
			expect(res.isError).toBe(true);
			expect(text(res)).toContain("locked");
		}
		expect(bridge.callsOf("updateNote")).toHaveLength(0);
	});

	test("always fetches note first with includeHtml false", async () => {
		await mod.handle("update_note", { id: "n1", title: "x" });
		expect(bridge.calls.map((c) => c.method)).toEqual(["getNote", "updateNote"]);
		expect(bridge.callsOf("getNote")[0]).toEqual(["n1", false]);
	});

	test("title change on plain note applies without confirm", async () => {
		const res = await mod.handle("update_note", { id: "n1", title: " New " });
		expect(res.isError).toBeUndefined();
		expect(text(res)).not.toContain("PREVIEW");
		expect(bridge.callsOf("updateNote")).toEqual([["n1", { title: "New", format: "text" }]]);
	});

	test("append on plain note applies without confirm, format passes through", async () => {
		const res = await mod.handle("update_note", {
			id: "n1",
			append: "<p>more</p>",
			format: "html",
		});
		expect(text(res)).not.toContain("PREVIEW");
		expect(bridge.callsOf("updateNote")).toEqual([
			["n1", { append: "<p>more</p>", format: "html" }],
		]);
	});

	test("body replacement without confirm previews and does not write", async () => {
		const res = await mod.handle("update_note", { id: "n1", body: "new" });
		expect(res.isError).toBeUndefined();
		const t = text(res);
		expect(t).toContain("PREVIEW");
		expect(t).toContain("Groceries");
		expect(t).toContain("Home");
		expect(t).toContain("replace the body");
		expect(bridge.callsOf("updateNote")).toHaveLength(0);
	});

	test("confirm:false still previews", async () => {
		const res = await mod.handle("update_note", { id: "n1", body: "new", confirm: false });
		expect(text(res)).toContain("PREVIEW");
		expect(bridge.callsOf("updateNote")).toHaveLength(0);
	});

	test("body replacement with confirm:true writes", async () => {
		const res = await mod.handle("update_note", {
			id: "n1",
			title: "T2",
			body: "new",
			confirm: true,
		});
		expect(res.isError).toBeUndefined();
		expect(text(res)).not.toContain("PREVIEW");
		expect(bridge.callsOf("updateNote")).toEqual([
			["n1", { title: "T2", body: "new", format: "text" }],
		]);
		expect("confirm" in (bridge.callsOf("updateNote")[0]![1] as object)).toBe(false);
	});

	test("attachments force confirm even for append; preview warns", async () => {
		bridge.note = { ...sample, attachments: ["a.png", "b.pdf"] };
		const res = await mod.handle("update_note", { id: "n1", append: "abcde" });
		const t = text(res);
		expect(t).toContain("PREVIEW");
		expect(t).toContain("append 5 characters");
		expect(t).toContain("has 2 attachments that may be lost");
		expect(t).not.toContain("shared with other people");
		expect(bridge.callsOf("updateNote")).toHaveLength(0);

		await mod.handle("update_note", { id: "n1", append: "abcde", confirm: true });
		expect(bridge.callsOf("updateNote")).toHaveLength(1);
	});

	test("single attachment is singular", async () => {
		bridge.note = { ...sample, attachments: ["a.png"] };
		const res = await mod.handle("update_note", { id: "n1", title: "x" });
		expect(text(res)).toContain("has 1 attachment that may be lost");
	});

	test("shared note forces confirm for rename; preview warns", async () => {
		bridge.note = { ...sample, shared: true };
		const res = await mod.handle("update_note", { id: "n1", title: "Renamed" });
		const t = text(res);
		expect(t).toContain("PREVIEW");
		expect(t).toContain('rename to "Renamed"');
		expect(t).toContain("is shared with other people");
		expect(t).not.toContain("attachment");
		expect(bridge.callsOf("updateNote")).toHaveLength(0);

		await mod.handle("update_note", { id: "n1", title: "Renamed", confirm: true });
		expect(bridge.callsOf("updateNote")).toHaveLength(1);
	});
});

describe("delete_note", () => {
	test("without confirm previews and does not delete", async () => {
		const res = await mod.handle("delete_note", { id: "n1" });
		expect(res.isError).toBeUndefined();
		const t = text(res);
		expect(t).toContain("PREVIEW");
		expect(t).toContain("Groceries");
		expect(t).toContain("Recently Deleted");
		expect(t).not.toContain("shared");
		expect(t).not.toContain("attachment");
		expect(bridge.callsOf("getNote")).toEqual([["n1", false]]);
		expect(bridge.callsOf("deleteNote")).toHaveLength(0);
	});

	test("preview mentions shared and attachments", async () => {
		bridge.note = { ...sample, shared: true, attachments: ["a.png"] };
		const t = text(await mod.handle("delete_note", { id: "n1", confirm: false }));
		expect(t).toContain("shared");
		expect(t).toContain("1 attachment");
		expect(bridge.callsOf("deleteNote")).toHaveLength(0);
	});

	test("locked note is an error, nothing deleted", async () => {
		bridge.note = { ...sample, locked: true, text: null };
		const res = await mod.handle("delete_note", { id: "n1", confirm: true });
		expect(res.isError).toBe(true);
		expect(text(res)).toContain("locked");
		expect(bridge.callsOf("deleteNote")).toHaveLength(0);
	});

	test("confirm:true deletes", async () => {
		const res = await mod.handle("delete_note", { id: "n1", confirm: true });
		expect(res.isError).toBeUndefined();
		expect(text(res)).not.toContain("PREVIEW");
		expect(bridge.callsOf("deleteNote")).toEqual([["n1"]]);
	});
});

describe("error handling", () => {
	test("bridge Error becomes isError result with message", async () => {
		bridge.error = new Error("boom from bridge");
		const origErr = console.error;
		console.error = () => {};
		try {
			for (const [name, args] of [
				["list_notes", {}],
				["update_note", { id: "n1", title: "x" }],
				["delete_note", { id: "n1", confirm: true }],
			] as const) {
				const res = await mod.handle(name, args);
				expect(res.isError).toBe(true);
				expect(text(res)).toContain("boom from bridge");
			}
		} finally {
			console.error = origErr;
		}
	});
});
