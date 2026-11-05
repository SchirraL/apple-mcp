import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadPolicy } from "../../src/lib/paths.js";
import { createObsidianBridge, type ObsidianBridge } from "../../src/tools/obsidian/bridge.js";
import {
	appendText,
	createObsidianModule,
	extractLinks,
	extractTags,
	formatMoment,
	parseFrontmatter,
	prependAfterFrontmatter,
	splitFrontmatter,
} from "../../src/tools/obsidian/handler.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "apple-mcp-obsidian-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const vaultDir = join(scratch, "allowed", "Main");
const otherVault = join(scratch, "elsewhere", "Secret");
const outside = join(scratch, "outside.md");
const config = join(scratch, "obsidian.json");
const policy = loadPolicy({ APPLE_MCP_FILE_ROOTS: join(scratch, "allowed") });
const opened: string[] = [];
const real = createObsidianBridge(config);
const bridge: ObsidianBridge = {
	...real,
	openUrl: async (u) => {
		opened.push(u);
	},
};
const mod = createObsidianModule(bridge, policy, () => new Date(2026, 10, 5, 9, 30));

function put(rel: string, text: string): void {
	const abs = join(vaultDir, rel);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, text);
}
const read = (rel: string): string => readFileSync(join(vaultDir, rel), "utf8");
async function call(name: string, args: Record<string, unknown> = {}) {
	const r = await mod.handle(name, args);
	return { err: r.isError === true, text: (r.content[0] as { text: string }).text };
}

beforeEach(() => {
	rmSync(vaultDir, { recursive: true, force: true });
	mkdirSync(join(vaultDir, ".obsidian"), { recursive: true });
	mkdirSync(otherVault, { recursive: true });
	writeFileSync(outside, "SECRET-CONTENT");
	writeFileSync(
		config,
		JSON.stringify({
			vaults: {
				a1: { path: vaultDir, ts: 1700000000000, open: true },
				b2: { path: otherVault, ts: 1600000000000 },
			},
		}),
	);
	opened.length = 0;
});

describe("pure helpers", () => {
	test("frontmatter subset", () => {
		const t = [
			"---",
			"title: Hello",
			'quoted: "a: b"',
			"n: 3",
			"done: true",
			"tags: [x, 'y z']",
			"aliases:",
			"  - One",
			"  - Two",
			"flush:",
			"- p",
			"nested:",
			"  k: v",
			"block: |",
			"  text",
			"empty:",
			"---",
			"body",
		].join("\n");
		const sp = splitFrontmatter(t);
		expect(sp.body).toBe("body");
		const fm = parseFrontmatter(sp.raw as string);
		expect(fm).toEqual({
			title: "Hello",
			quoted: "a: b",
			n: 3,
			done: true,
			tags: ["x", "y z"],
			aliases: ["One", "Two"],
			flush: ["p"],
			empty: null,
		});
	});
	test("no or unclosed frontmatter", () => {
		expect(splitFrontmatter("# hi").raw).toBeNull();
		expect(splitFrontmatter("---\nnever closed").raw).toBeNull();
		expect(splitFrontmatter("---\n---\nx").raw).toBe("");
	});
	test("links ignore code, keep embeds", () => {
		const l = extractLinks("[[A]] [[B#H|al]] ![[img.png]] `[[no]]`\n```\n[[nope]]\n```\n[[A]]");
		expect(l).toEqual([
			{ target: "A", embed: false },
			{ target: "B", embed: false, heading: "H", alias: "al" },
			{ target: "img.png", embed: true },
		]);
	});
	test("tags: inline, frontmatter, not headings or numbers", () => {
		const t = extractTags({ tags: ["#fm", "two"] }, "# Heading\ntext #inline #a/b #123 `#code`");
		expect(t).toEqual(["a/b", "fm", "inline", "two"]);
	});
	test("moment tokens", () => {
		const d = new Date(2026, 10, 5, 9, 7);
		expect(formatMoment(d, "YYYY-MM-DD")).toBe("2026-11-05");
		expect(formatMoment(d, "dddd, MMMM D [of] YYYY")).toBe("Thursday, November 5 of 2026");
		expect(formatMoment(d, "ddd MMM DD")).toBe("Thu Nov 05");
	});
	test("append / prepend", () => {
		expect(appendText("a", "b")).toBe("a\nb\n");
		expect(appendText("a\n", "b\n")).toBe("a\nb\n");
		expect(prependAfterFrontmatter("---\nk: v\n---\nbody", "new")).toBe("---\nk: v\n---\nnew\nbody");
		expect(prependAfterFrontmatter("body", "new")).toBe("new\nbody");
	});
});

describe("vaults and listing", () => {
	test("list_vaults hides vaults outside the allowed roots", async () => {
		put("a.md", "x");
		const r = await call("obsidian_list_vaults");
		const rows = JSON.parse(r.text.slice(r.text.indexOf("[")));
		expect(rows[0]).toMatchObject({ name: "Main", notes: 1, open: true });
		expect(rows[1].name).toBe("(outside allowed locations)");
		expect(rows[1].path).toBeUndefined();
		expect(rows[1].notes).toBeUndefined();
		expect(r.text).not.toContain("Secret");
	});
	test("outside vault is refused by name", async () => {
		expect((await call("obsidian_list_notes", { vault: "Secret" })).err).toBe(true);
	});
	test("default vault = the open one; unknown name errors", async () => {
		put("a.md", "x");
		expect((await call("obsidian_list_notes")).err).toBe(false);
		expect((await call("obsidian_list_notes", { vault: "nope" })).text).toContain("Unknown vault");
	});
	test("list_notes sorts by modified, skips dot-folders", async () => {
		put("old.md", "x");
		put("sub/new.md", "x");
		put(".trash/t.md", "x");
		put("img.png", "x");
		const old = new Date(2020, 0, 1);
		require("node:fs").utimesSync(join(vaultDir, "old.md"), old, old);
		const r = await call("obsidian_list_notes", {});
		expect(r.text.indexOf("sub/new.md")).toBeLessThan(r.text.indexOf("old.md"));
		expect(r.text).not.toContain(".trash");
		expect(r.text).not.toContain("img.png");
		const nr = await call("obsidian_list_notes", { folder: "sub", recursive: false });
		expect(nr.text).toContain('"path": "sub/new.md"');
		expect((await call("obsidian_list_notes", { folder: "../x" })).err).toBe(true);
	});
});

describe("search", () => {
	beforeEach(() => {
		put("Projects/Alpha.md", "---\ntags: [work]\n---\nThe quick brown fox\njumps over");
		put("Beta.md", "Nothing here #personal/health");
		put("fox.md", "unrelated");
	});
	test("all words, case-insensitive, with snippet", async () => {
		const r = await call("obsidian_search_notes", { query: "FOX brown" });
		expect(r.text).toContain("Projects/Alpha.md");
		expect(r.text).toContain("quick brown fox");
		expect(r.text).not.toContain("Beta.md");
		expect(r.text).not.toContain('"fox.md"');
	});
	test("name match ranks first", async () => {
		const r = await call("obsidian_search_notes", { query: "fox" });
		expect(r.text.indexOf('"fox.md"')).toBeLessThan(r.text.indexOf("Alpha.md"));
	});
	test("tag filter: frontmatter, inline, nested parent", async () => {
		expect((await call("obsidian_search_notes", { tag: "#work" })).text).toContain("Alpha.md");
		const t = await call("obsidian_search_notes", { tag: "personal" });
		expect(t.text).toContain("Beta.md");
		expect(t.text).not.toContain("Alpha.md");
	});
	test("folder filter and missing criteria", async () => {
		const r = await call("obsidian_search_notes", { query: "here", folder: "Projects" });
		expect(r.text).toContain("0 match");
		expect((await call("obsidian_search_notes", {})).err).toBe(true);
	});
});

describe("read", () => {
	beforeEach(() => {
		put("Projects/Alpha.md", "---\nstatus: open\ntags: [work]\n---\nSee [[Beta]] and ![[pic.png]] #todo");
		put("Beta.md", "back to [[Alpha]]");
		put("Other/Alpha.md", "dup");
		put("Gamma.md", "x".repeat(100));
	});
	test("by path, with frontmatter/links/tags", async () => {
		const r = await call("obsidian_read_note", { note: "Projects/Alpha" });
		expect(r.err).toBe(false);
		expect(r.text).toContain('"status": "open"');
		expect(r.text).toContain('"target": "Beta"');
		expect(r.text).toContain('"embed": true');
		expect(r.text).toContain('"todo"');
		expect(r.text).toContain("--- body ---\nSee [[Beta]]");
	});
	test("wikilink name; ambiguity lists candidates; not found", async () => {
		expect((await call("obsidian_read_note", { note: "[[Beta|alias]]" })).text).toContain("back to");
		const amb = await call("obsidian_read_note", { note: "Alpha" });
		expect(amb.err).toBe(true);
		expect(amb.text).toContain("Projects/Alpha.md");
		expect(amb.text).toContain("Other/Alpha.md");
		expect((await call("obsidian_read_note", { note: "Zzz" })).err).toBe(true);
	});
	test("paging", async () => {
		const r = await call("obsidian_read_note", { note: "Gamma", limit: 40, offset: 10 });
		expect(r.text).toContain('"nextOffset": 50');
		expect(r.text.split("--- body ---\n")[1]).toHaveLength(40);
	});
	test("backlinks", async () => {
		const r = await call("obsidian_read_note", { note: "Beta", includeBacklinks: true });
		expect(r.text).toContain('"path": "Projects/Alpha.md"');
		expect(r.text).not.toContain('"path": "Other/Alpha.md"');
	});
	test("rejects escapes", async () => {
		for (const note of ["../../outside", "/etc/hosts", ".obsidian/app", "~/x"]) {
			expect((await call("obsidian_read_note", { note })).err).toBe(true);
		}
	});
	test("symlink pointing outside the vault is refused", async () => {
		symlinkSync(outside, join(vaultDir, "link.md"));
		const r = await call("obsidian_read_note", { note: "link.md" });
		expect(r.err).toBe(true);
		expect(r.text).not.toContain("SECRET-CONTENT");
	});
});

describe("write", () => {
	test("create makes folders, adds .md, fails if exists", async () => {
		const r = await call("obsidian_write_note", { path: "New/Deep/Idea", content: "hi" });
		expect(r.err).toBe(false);
		expect(read("New/Deep/Idea.md")).toBe("hi");
		expect((await call("obsidian_write_note", { path: "New/Deep/Idea", content: "x" })).err).toBe(true);
		expect(read("New/Deep/Idea.md")).toBe("hi");
	});
	test("overwrite is confirm-gated when it exists", async () => {
		put("N.md", "old");
		const p = await call("obsidian_write_note", { path: "N", content: "new", mode: "overwrite" });
		expect(p.text).toContain("PREVIEW");
		expect(read("N.md")).toBe("old");
		await call("obsidian_write_note", { path: "N", content: "new", mode: "overwrite", confirm: true });
		expect(read("N.md")).toBe("new");
		const fresh = await call("obsidian_write_note", { path: "F", content: "1", mode: "overwrite" });
		expect(fresh.text).not.toContain("PREVIEW");
		expect(read("F.md")).toBe("1");
	});
	test("no stray temp files after overwrite", async () => {
		put("N.md", "old");
		await call("obsidian_write_note", { path: "N", content: "new", mode: "overwrite", confirm: true });
		const names = require("node:fs").readdirSync(vaultDir) as string[];
		expect(names.filter((n) => n.endsWith(".tmp"))).toEqual([]);
	});
	test("append and prepend need no confirm; missing note errors", async () => {
		put("N.md", "---\nk: v\n---\nbody");
		await call("obsidian_write_note", { path: "N", content: "tail", mode: "append" });
		await call("obsidian_write_note", { path: "N", content: "head", mode: "prepend" });
		expect(read("N.md")).toBe("---\nk: v\n---\nhead\nbody\ntail\n");
		expect((await call("obsidian_write_note", { path: "Nope", content: "x", mode: "append" })).err).toBe(true);
		expect(existsSync(join(vaultDir, "Nope.md"))).toBe(false);
	});
	test("path escapes and hidden folders are refused", async () => {
		for (const path of ["../evil", "/tmp/evil", "a/../../evil", ".obsidian/plugins/x", "~/e"]) {
			const r = await call("obsidian_write_note", { path, content: "x" });
			expect(r.err).toBe(true);
		}
		expect(existsSync(join(scratch, "evil.md"))).toBe(false);
		expect(existsSync(join(scratch, "allowed", "evil.md"))).toBe(false);
	});
	test("symlinked folder escaping the vault is refused", async () => {
		symlinkSync(join(scratch, "elsewhere"), join(vaultDir, "esc"));
		const r = await call("obsidian_write_note", { path: "esc/x", content: "x" });
		expect(r.err).toBe(true);
		expect(existsSync(join(scratch, "elsewhere", "x.md"))).toBe(false);
	});
});

describe("daily note", () => {
	test("default settings: read missing, append creates", async () => {
		expect((await call("obsidian_daily_note", {})).text).toContain("No daily note yet");
		const r = await call("obsidian_daily_note", { action: "append", content: "- item" });
		expect(r.err).toBe(false);
		expect(read("2026-11-05.md")).toBe("- item\n");
		await call("obsidian_daily_note", { action: "append", content: "- two" });
		expect(read("2026-11-05.md")).toBe("- item\n- two\n");
		expect((await call("obsidian_daily_note", {})).text).toContain("- two");
	});
	test("folder, format, template, explicit date", async () => {
		writeFileSync(
			join(vaultDir, ".obsidian", "daily-notes.json"),
			JSON.stringify({ folder: "Journal/Daily", format: "YYYY/MMMM/DD-ddd", template: "Templates/Day" }),
		);
		put("Templates/Day.md", "# {{title}} ({{date:dddd}})\n");
		await call("obsidian_daily_note", { action: "append", content: "entry", date: "2026-01-02" });
		expect(read("Journal/Daily/2026/January/02-Fri.md")).toBe("# 02-Fri (Friday)\nentry\n");
	});
	test("bad inputs", async () => {
		expect((await call("obsidian_daily_note", { date: "2026-02-30" })).err).toBe(true);
		expect((await call("obsidian_daily_note", { action: "append" })).err).toBe(true);
		writeFileSync(join(vaultDir, ".obsidian", "daily-notes.json"), JSON.stringify({ folder: "../x" }));
		expect((await call("obsidian_daily_note", { action: "append", content: "x" })).err).toBe(true);
	});
});

describe("open", () => {
	test("encodes the URL; resolves note names", async () => {
		put("My Notes/A&B 1.md", "x");
		const r = await call("obsidian_open_note", { note: "A&B 1" });
		expect(r.err).toBe(false);
		expect(opened).toEqual(["obsidian://open?vault=a1&file=My%20Notes%2FA%26B%201"]);
		await call("obsidian_open_note", {});
		expect(opened[1]).toBe("obsidian://open?vault=a1");
		expect((await call("obsidian_open_note", { note: "missing" })).err).toBe(true);
	});
});
