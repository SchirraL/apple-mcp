import { beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolModule } from "../../src/lib/types.js";
import type {
	FileInfo,
	FinderBridge,
	SelectionInfo,
	SpotlightRequest,
} from "../../src/tools/finder/bridge.js";
import {
	buildSpotlightQuery,
	createFinderModule,
	escapeSpotlight,
} from "../../src/tools/finder/handler.js";

const H = homedir();
const p = (s: string): string => join(H, s);

class FakeBridge implements FinderBridge {
	calls: { method: string; args: unknown[] }[] = [];
	paths: string[] = [];
	mtimes: Record<string, string> = {};
	existing = true;
	tags: string[] = [];
	selection: SelectionInfo = { selection: [], frontWindowFolder: null };

	private rec(method: string, ...args: unknown[]): void {
		this.calls.push({ method, args });
	}
	callsOf(m: string): unknown[][] {
		return this.calls.filter((c) => c.method === m).map((c) => c.args);
	}
	async spotlight(req: SpotlightRequest) {
		this.rec("spotlight", req);
		return { paths: this.paths, truncated: false };
	}
	async stat(paths: string[]): Promise<FileInfo[]> {
		this.rec("stat", paths);
		if (!this.existing) return [];
		return paths.map((path) => ({
			path,
			name: path.split("/").pop() as string,
			kind: "other",
			size: 1,
			modified: this.mtimes[path] ?? "2026-01-01T00:00:00.000Z",
		}));
	}
	async getSelection() {
		this.rec("getSelection");
		return this.selection;
	}
	async reveal(path: string) {
		this.rec("reveal", path);
	}
	async getTags(path: string) {
		this.rec("getTags", path);
		return [...this.tags];
	}
	async setTags(path: string, tags: string[]) {
		this.rec("setTags", path, tags);
	}
}

function text(res: { content: unknown }): string {
	return (res.content as { text: string }[]).map((c) => c.text).join("\n");
}

let bridge: FakeBridge;
let mod: ToolModule;
beforeEach(() => {
	bridge = new FakeBridge();
	mod = createFinderModule(bridge);
});

describe("escapeSpotlight", () => {
	test("escapes quotes and backslashes", () => {
		expect(escapeSpotlight('a"b\\c')).toBe('a\\"b\\\\c');
	});
	test("wildcards literal by default, passthrough when asked", () => {
		expect(escapeSpotlight("a*b")).toBe("a\\*b");
		expect(escapeSpotlight("a*b", true)).toBe("a*b");
	});
	test("newlines cannot break out of the string", () => {
		expect(escapeSpotlight('x"\n|| kMDItemFSName == "*')).not.toContain("\n");
	});
	test("injection attempt stays inside the quoted literal", () => {
		const q = buildSpotlightQuery({ query: 'x"||y\\' });
		expect(q).toContain('"*x\\"||y\\\\*"cd');
		// only the 4 structural quote pairs of one token remain unescaped
		expect(q.replace(/\\\\/g, "").match(/(?<!\\)"/g)?.length).toBe(4);
	});
});

describe("buildSpotlightQuery", () => {
	test("name or content per token, ANDed", () => {
		expect(buildSpotlightQuery({ query: "foo bar" })).toBe(
			'(kMDItemFSName == "*foo*"cd || kMDItemTextContent == "foo"cd) && ' +
				'(kMDItemFSName == "*bar*"cd || kMDItemTextContent == "bar"cd)',
		);
	});
	test("nameOnly skips content", () => {
		expect(buildSpotlightQuery({ query: "a", nameOnly: true })).toBe('kMDItemFSName == "*a*"cd');
	});
	test("kind and dates", () => {
		const q = buildSpotlightQuery({
			kind: "pdf",
			modifiedSince: "2026-01-02T03:04:05.678Z",
			modifiedBefore: "2026-02-01",
		});
		expect(q).toContain('kMDItemContentTypeTree == "com.adobe.pdf"');
		expect(q).toContain("$time.iso(2026-01-02T03:04:05Z)");
		expect(q).toContain("kMDItemFSContentChangeDate < $time.iso(2026-02-01T00:00:00Z)");
	});
	test("multi-type kind is parenthesised", () => {
		expect(buildSpotlightQuery({ kind: "spreadsheet" })).toMatch(/^\(.* \|\| .*\)$/);
	});
	test("rejects empty criteria and bad dates", () => {
		expect(() => buildSpotlightQuery({})).toThrow();
		expect(() => buildSpotlightQuery({ query: "  " })).toThrow();
		expect(() => buildSpotlightQuery({ modifiedSince: "garbage" })).toThrow(/ISO/);
	});
	test("recent files", () => {
		expect(buildSpotlightQuery({ usedWithinSeconds: 86400 })).toBe(
			"kMDItemLastUsedDate >= $time.now(-86400)",
		);
	});
});

describe("tools list", () => {
	test("exposes the finder tools", () => {
		expect(mod.tools.map((t) => t.name).sort()).toEqual([
			"get_file_tags",
			"get_finder_selection",
			"list_recent_files",
			"reveal_in_finder",
			"search_files",
			"set_file_tags",
		]);
	});
});

describe("search_files", () => {
	test("filters disallowed paths, sorts newest first, applies limit", async () => {
		bridge.paths = [p("a.txt"), p(".ssh/id_rsa"), "/etc/passwd", p("b.txt"), p("c.txt")];
		bridge.mtimes = {
			[p("a.txt")]: "2026-01-01T00:00:00.000Z",
			[p("b.txt")]: "2026-03-01T00:00:00.000Z",
			[p("c.txt")]: "2026-02-01T00:00:00.000Z",
		};
		const res = await mod.handle("search_files", { query: "x", limit: 2 });
		expect(res.isError).toBeUndefined();
		const t = text(res);
		expect(t).not.toContain("id_rsa");
		expect(t).not.toContain("/etc/passwd");
		expect(t.indexOf("b.txt")).toBeLessThan(t.indexOf("c.txt"));
		expect(t).not.toContain("a.txt");
		expect(bridge.callsOf("stat")[0]?.[0]).toEqual([p("a.txt"), p("b.txt"), p("c.txt")]);
	});
	test("skips ~/Library unless searched inside", async () => {
		bridge.paths = [p("Library/x.txt"), p("d.txt")];
		expect(text(await mod.handle("search_files", { query: "x" }))).not.toContain("Library");
		const inside = await mod.handle("search_files", { query: "x", folder: "~/Library" });
		expect(text(inside)).toContain("Library/x.txt");
	});
	test("folder is policy-checked", async () => {
		const res = await mod.handle("search_files", { query: "x", folder: "/etc" });
		expect(res.isError).toBe(true);
		expect(bridge.calls).toHaveLength(0);
	});
	test("needs a criterion", async () => {
		expect((await mod.handle("search_files", {})).isError).toBe(true);
	});
	test("passes -onlyin root and query to bridge", async () => {
		await mod.handle("search_files", { query: "a*b", nameOnly: true });
		const req = bridge.callsOf("spotlight")[0]?.[0] as SpotlightRequest;
		expect(req.folder).toBe(H);
		expect(req.query).toBe('kMDItemFSName == "*a\\*b*"cd');
	});
});

describe("list_recent_files", () => {
	test("uses last-used date window", async () => {
		bridge.paths = [p("r.txt")];
		const res = await mod.handle("list_recent_files", { days: 2, kind: "pdf" });
		expect(text(res)).toContain("r.txt");
		const req = bridge.callsOf("spotlight")[0]?.[0] as SpotlightRequest;
		expect(req.query).toContain("kMDItemLastUsedDate >= $time.now(-172800)");
		expect(req.query).toContain("com.adobe.pdf");
	});
});

describe("get_finder_selection", () => {
	test("filters by policy", async () => {
		bridge.selection = {
			selection: [p("ok.txt"), p(".ssh/key")],
			frontWindowFolder: p(".aws"),
		};
		const res = await mod.handle("get_finder_selection", {});
		const t = text(res);
		expect(t).toContain("ok.txt");
		expect(t).not.toContain(".ssh");
		expect(t).toContain('"frontWindowFolder": null');
		expect(t).toContain("1 item outside");
	});
});

describe("reveal_in_finder", () => {
	test("reveals existing allowed path", async () => {
		await mod.handle("reveal_in_finder", { path: "~/x.txt" });
		expect(bridge.callsOf("reveal")).toEqual([[p("x.txt")]]);
	});
	test("blocked and missing paths do not reveal", async () => {
		expect((await mod.handle("reveal_in_finder", { path: "~/.ssh/id" })).isError).toBe(true);
		bridge.existing = false;
		expect((await mod.handle("reveal_in_finder", { path: "~/gone" })).isError).toBe(true);
		expect(bridge.callsOf("reveal")).toHaveLength(0);
	});
});

describe("tags", () => {
	test("get_file_tags", async () => {
		bridge.tags = ["Red"];
		expect(text(await mod.handle("get_file_tags", { path: "~/x" }))).toContain("Red");
	});
	test("add applies without confirm and dedupes case-insensitively", async () => {
		bridge.tags = ["Work"];
		await mod.handle("set_file_tags", { path: "~/x", tags: ["work", "New"] });
		expect(bridge.callsOf("setTags")).toEqual([[p("x"), ["Work", "New"]]]);
	});
	test("add of already-present tag writes nothing", async () => {
		bridge.tags = ["Work"];
		await mod.handle("set_file_tags", { path: "~/x", tags: ["Work"] });
		expect(bridge.callsOf("setTags")).toHaveLength(0);
	});
	test("replace that drops tags previews without confirm", async () => {
		bridge.tags = ["A", "B"];
		const res = await mod.handle("set_file_tags", { path: "~/x", tags: ["B", "C"], mode: "replace" });
		expect(text(res)).toContain("PREVIEW");
		expect(text(res)).toContain('"A"');
		expect(bridge.callsOf("setTags")).toHaveLength(0);
	});
	test("replace with confirm applies", async () => {
		bridge.tags = ["A", "B"];
		await mod.handle("set_file_tags", {
			path: "~/x",
			tags: ["B", "C"],
			mode: "replace",
			confirm: true,
		});
		expect(bridge.callsOf("setTags")).toEqual([[p("x"), ["B", "C"]]]);
	});
	test("replace that drops nothing needs no confirm", async () => {
		bridge.tags = ["A"];
		await mod.handle("set_file_tags", { path: "~/x", tags: ["A", "B"], mode: "replace" });
		expect(bridge.callsOf("setTags")).toEqual([[p("x"), ["A", "B"]]]);
	});
	test("remove needs confirm; no-op remove does not", async () => {
		bridge.tags = ["A", "B"];
		const prev = await mod.handle("set_file_tags", { path: "~/x", tags: ["a"], mode: "remove" });
		expect(text(prev)).toContain("PREVIEW");
		expect(bridge.callsOf("setTags")).toHaveLength(0);
		await mod.handle("set_file_tags", { path: "~/x", tags: ["a"], mode: "remove", confirm: true });
		expect(bridge.callsOf("setTags")).toEqual([[p("x"), ["B"]]]);
		bridge.calls = [];
		const noop = await mod.handle("set_file_tags", { path: "~/x", tags: ["Zed"], mode: "remove" });
		expect(text(noop)).not.toContain("PREVIEW");
	});
	test("clear all via replace [] needs confirm", async () => {
		bridge.tags = ["A"];
		const res = await mod.handle("set_file_tags", { path: "~/x", tags: [], mode: "replace" });
		expect(text(res)).toContain("PREVIEW");
	});
	test("validation and policy", async () => {
		expect((await mod.handle("set_file_tags", { path: "~/x", tags: [] })).isError).toBe(true);
		expect((await mod.handle("set_file_tags", { path: "~/x", tags: ["a\nb"] })).isError).toBe(true);
		expect((await mod.handle("set_file_tags", { path: "/etc/hosts", tags: ["a"] })).isError).toBe(true);
		expect(bridge.callsOf("setTags")).toHaveLength(0);
	});
});
