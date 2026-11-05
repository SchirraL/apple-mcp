import { beforeEach, describe, expect, test } from "bun:test";
import type { ToolModule } from "../../src/lib/types.js";
import type {
	Contact,
	ContactDetail,
	ContactPage,
	ContactPatch,
	ContactsBridge,
	NewContact,
} from "../../src/tools/contacts/bridge.js";
import { createContactsModule } from "../../src/tools/contacts/handler.js";
import { normalizePhone, phonesMatch } from "../../src/tools/contacts/phone.js";

const summary: Contact = {
	id: "c1",
	name: "Test Person",
	organization: "Acme",
	phones: [{ label: "mobile", value: "+49 171 1234567" }],
	emails: [{ label: "work", value: "t@example.com" }],
};

const detail: ContactDetail = {
	...summary,
	givenName: "Test",
	familyName: "Person",
	nickname: null,
	jobTitle: "Engineer",
	department: null,
	birthday: null,
	addresses: [],
	urls: [],
};

class FakeBridge implements ContactsBridge {
	calls: { method: string; args: unknown[] }[] = [];
	error: Error | null = null;
	current: ContactDetail = detail;

	private record(method: string, ...args: unknown[]): void {
		this.calls.push({ method, args });
		if (this.error) throw this.error;
	}
	callsOf(method: string): unknown[][] {
		return this.calls.filter((c) => c.method === method).map((c) => c.args);
	}

	async search(query: string, limit: number): Promise<ContactPage> {
		this.record("search", query, limit);
		return { total: 1, contacts: [summary] };
	}
	async get(id: string) {
		this.record("get", id);
		return this.current;
	}
	async list(limit: number, offset: number): Promise<ContactPage> {
		this.record("list", limit, offset);
		return { total: 120, contacts: [summary] };
	}
	async findByPhone(phone: string, limit: number) {
		this.record("findByPhone", phone, limit);
		return [summary];
	}
	async create(c: NewContact) {
		this.record("create", c);
		return { ...detail, name: c.givenName ?? "x" };
	}
	async update(id: string, patch: ContactPatch) {
		this.record("update", id, patch);
		return detail;
	}
}

function text(res: { content: unknown }): string {
	return (res.content as { text: string }[]).map((c) => c.text).join("\n");
}

let bridge: FakeBridge;
let mod: ToolModule;

beforeEach(() => {
	bridge = new FakeBridge();
	mod = createContactsModule(bridge);
});

describe("phone normalisation", () => {
	test("keeps digits and a leading plus only", () => {
		expect(normalizePhone("+49 (171) 123-4567")).toBe("+491711234567");
		expect(normalizePhone("0171/123 4567")).toBe("01711234567");
		expect(normalizePhone("  +1.555.123.4567 ")).toBe("+15551234567");
		expect(normalizePhone("12+34")).toBe("1234");
		expect(normalizePhone("abc")).toBe("");
	});

	test("international and national forms match", () => {
		expect(phonesMatch("+49 171 1234567", "0171 1234567")).toBe(true);
		expect(phonesMatch("0049 171 1234567", "0171-1234567")).toBe(true);
		expect(phonesMatch("+1 (555) 123-4567", "5551234567")).toBe(true);
		expect(phonesMatch("(555) 123-4567", "+15551234567")).toBe(true);
	});

	test("different numbers do not match", () => {
		expect(phonesMatch("+49 171 1234567", "0171 1234568")).toBe(false);
		expect(phonesMatch("+49 171 1234567", "+49 172 1234567")).toBe(false);
	});

	test("short or empty numbers need to be identical", () => {
		expect(phonesMatch("1234567", "0301234567")).toBe(false);
		expect(phonesMatch("112", "112")).toBe(true);
		expect(phonesMatch("", "")).toBe(false);
		expect(phonesMatch("abc", "123456789")).toBe(false);
	});
});

describe("tools list", () => {
	test("exposes exactly the expected tools", () => {
		expect(mod.tools.map((t) => t.name).sort()).toEqual(
			[
				"create_contact",
				"find_contact_by_phone",
				"get_contact",
				"list_contacts",
				"search_contacts",
				"update_contact",
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

describe("read tools", () => {
	test("search_contacts passes query and default limit", async () => {
		const res = await mod.handle("search_contacts", { query: "test" });
		expect(res.isError).toBeUndefined();
		expect(bridge.callsOf("search")[0]).toEqual(["test", 25]);
		expect(text(res)).toContain("Test Person");
	});

	test("search_contacts rejects empty query", async () => {
		const res = await mod.handle("search_contacts", { query: "  " });
		expect(res.isError).toBe(true);
		expect(bridge.calls).toHaveLength(0);
	});

	test("get_contact returns detail", async () => {
		const res = await mod.handle("get_contact", { id: "c1" });
		expect(text(res)).toContain("Engineer");
	});

	test("list_contacts pages", async () => {
		const res = await mod.handle("list_contacts", { limit: 10, offset: 20 });
		expect(bridge.callsOf("list")[0]).toEqual([10, 20]);
		expect(text(res)).toContain("21-21 of 120");
	});

	test("find_contact_by_phone validates and forwards", async () => {
		expect((await mod.handle("find_contact_by_phone", { phone: "ab" })).isError).toBe(true);
		const res = await mod.handle("find_contact_by_phone", { phone: "0171 1234567" });
		expect(bridge.callsOf("findByPhone")[0]).toEqual(["0171 1234567", 5]);
		expect(text(res)).toContain("1 contacts");
	});

	test("bridge errors become error results", async () => {
		bridge.error = new Error("No access to Contacts.");
		const res = await mod.handle("list_contacts", {});
		expect(res.isError).toBe(true);
		expect(text(res)).toContain("No access to Contacts");
	});
});

describe("create_contact", () => {
	test("creates without confirm", async () => {
		const res = await mod.handle("create_contact", {
			givenName: "[apple-mcp-test]",
			phones: [{ value: "+49 171 0000000", label: "mobile" }, { value: "123456" }],
			emails: [{ value: "a@example.com" }],
		});
		expect(res.isError).toBeUndefined();
		const [arg] = bridge.callsOf("create")[0] as [NewContact];
		expect(arg.givenName).toBe("[apple-mcp-test]");
		expect(arg.phones).toEqual([
			{ label: "mobile", value: "+49 171 0000000" },
			{ label: null, value: "123456" },
		]);
	});

	test("requires a name or organisation", async () => {
		const res = await mod.handle("create_contact", { phones: [{ value: "123456" }] });
		expect(res.isError).toBe(true);
		expect(bridge.callsOf("create")).toHaveLength(0);
	});

	test("rejects bad email and birthday", async () => {
		expect(
			(await mod.handle("create_contact", { givenName: "x", emails: [{ value: "nope" }] }))
				.isError,
		).toBe(true);
		expect(
			(await mod.handle("create_contact", { givenName: "x", birthday: "1.2.1990" })).isError,
		).toBe(true);
		expect(bridge.callsOf("create")).toHaveLength(0);
	});
});

describe("update_contact", () => {
	test("adding a phone and email needs no confirm", async () => {
		const res = await mod.handle("update_contact", {
			id: "c1",
			addPhones: [{ value: "+49 172 5555555", label: "work" }],
			addEmails: [{ value: "x@example.com" }],
		});
		expect(res.isError).toBeUndefined();
		expect(text(res)).not.toContain("PREVIEW");
		const [id, patch] = bridge.callsOf("update")[0] as [string, ContactPatch];
		expect(id).toBe("c1");
		expect(patch.addPhones).toEqual([{ label: "work", value: "+49 172 5555555" }]);
		expect(patch.addEmails).toEqual([{ label: null, value: "x@example.com" }]);
	});

	test("filling an empty field needs no confirm", async () => {
		await mod.handle("update_contact", { id: "c1", department: "R&D" });
		expect(bridge.callsOf("update")).toHaveLength(1);
	});

	test("setting a field to its current value needs no confirm", async () => {
		await mod.handle("update_contact", { id: "c1", jobTitle: "Engineer" });
		expect(bridge.callsOf("update")).toHaveLength(1);
	});

	test("overwriting a field previews and changes nothing", async () => {
		const res = await mod.handle("update_contact", { id: "c1", jobTitle: "Manager" });
		expect(text(res)).toContain("PREVIEW");
		expect(text(res)).toContain('"Engineer" -> "Manager"');
		expect(bridge.callsOf("update")).toHaveLength(0);
	});

	test("overwriting with confirm: true applies and omits confirm from patch", async () => {
		const res = await mod.handle("update_contact", {
			id: "c1",
			jobTitle: "Manager",
			confirm: true,
		});
		expect(text(res)).not.toContain("PREVIEW");
		const [, patch] = bridge.callsOf("update")[0] as [string, ContactPatch];
		expect(patch).toEqual({ jobTitle: "Manager" });
	});

	test("clearing a populated field needs confirm", async () => {
		const res = await mod.handle("update_contact", { id: "c1", organization: null });
		expect(text(res)).toContain("(cleared)");
		expect(bridge.callsOf("update")).toHaveLength(0);
	});

	test("mixed add and overwrite is gated as a whole", async () => {
		const res = await mod.handle("update_contact", {
			id: "c1",
			familyName: "Other",
			addPhones: [{ value: "123456789" }],
		});
		expect(text(res)).toContain("PREVIEW");
		expect(bridge.callsOf("update")).toHaveLength(0);
	});

	test("requires at least one change", async () => {
		const res = await mod.handle("update_contact", { id: "c1" });
		expect(res.isError).toBe(true);
		expect(bridge.calls).toHaveLength(0);
	});
});
