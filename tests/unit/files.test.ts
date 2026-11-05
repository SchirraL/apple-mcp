import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy } from "../../src/lib/paths.js";
import {
	type FileInfo,
	type FilesBridge,
	filesBridge,
	globToRegExp,
	type ListOptions,
	type TextRead,
	type WriteMode,
} from "../../src/tools/files/bridge.js";
import { createFilesModule } from "../../src/tools/files/handler.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "apple-mcp-files-")));
const root = join(scratch, "root");
mkdirSync(root);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const policy = loadPolicy({ APPLE_MCP_FILE_ROOTS: root });

function infoOf(path: string, over: Partial<FileInfo> = {}): FileInfo {
	return {
		path,
		name: path.split("/").pop() as string,
		type: "file",
		kind: "Plain text",
		size: 10,
		created: "2024-01-01T00:00:00.000Z",
		modified: "2024-01-01T00:00:00.000Z",
		permissions: "rw-r--r-- (644)",
		owner: 501,
		symlinkTarget: null,
		...over,
	};
}

class FakeBridge implements FilesBridge {
	existing = new Map<string, FileInfo>();
	text: TextRead = { kind: "text", text: "a\nb\nc", encoding: "utf-8", size: 5 };
	rich = "rich text";
	calls: string[] = [];
	listOpts: ListOptions | null = null;

	async list(_d: string, o: ListOptions) {
		this.listOpts = o;
		return { entries: [], truncated: false };
	}
	async info(p: string) {
		return this.existing.get(p) ?? null;
	}
	async readText(_p: string) {
		return this.text;
	}
	async readRich(p: string) {
		this.calls.push(`rich ${p}`);
		return this.rich;
	}
	async peek() {
		return "old line 1\nold line 2";
	}
	async write(p: string, c: string, m: WriteMode, d: boolean) {
		this.calls.push(`write ${m} ${p} ${c.length} ${d}`);
	}
	async mkdir(p: string) {
		this.calls.push(`mkdir ${p}`);
	}
	async move(a: string, b: string) {
		this.calls.push(`move ${a} ${b}`);
	}
	async trash(p: string) {
		this.calls.push(`trash ${p}`);
		return "/Users/x/.Trash/f";
	}
}

function setup() {
	const bridge = new FakeBridge();
	const mod = createFilesModule(bridge, policy);
	const call = async (name: string, args: unknown) => {
		const r = await mod.handle(name, args);
		return { text: (r.content[0] as { text: string }).text, isError: Boolean(r.isError) };
	};
	return { bridge, mod, call };
}
const f = (n: string) => join(root, n);

describe("module shape", () => {
	test("tool names", () => {
		expect(setup().mod.tools.map((t) => t.name)).toEqual([
			"list_files",
			"get_file_info",
			"read_file",
			"write_file",
			"create_folder",
			"move_file",
			"trash_file",
		]);
	});
});

describe("path policy", () => {
	test("outside paths are rejected before touching the bridge", async () => {
		const { call, bridge } = setup();
		for (const [n, a] of [
			["read_file", { path: "/etc/hosts" }],
			["write_file", { path: "/etc/x", content: "a" }],
			["trash_file", { path: "/etc/hosts", confirm: true }],
			["move_file", { from: f("a"), to: "/etc/b", confirm: true }],
		] as const) {
			const r = await call(n, a);
			expect(r.isError).toBe(true);
			expect(r.text).toMatch(/outside/);
		}
		expect(bridge.calls).toEqual([]);
	});
});

describe("read_file", () => {
	test("pages by lines", async () => {
		const { call, bridge } = setup();
		bridge.existing.set(f("a.txt"), infoOf(f("a.txt")));
		const r = await call("read_file", { path: f("a.txt"), offset: 1, limit: 1 });
		expect(r.text).toContain("offset 2");
		expect(r.text.endsWith("\n\nb")).toBe(true);
	});
	test("refuses binary and PDFs with hints", async () => {
		const { call, bridge } = setup();
		bridge.existing.set(f("b.bin"), infoOf(f("b.bin")));
		bridge.existing.set(f("c.pdf"), infoOf(f("c.pdf")));
		bridge.text = { kind: "binary", size: 9 };
		expect((await call("read_file", { path: f("b.bin") })).text).toMatch(/binary/);
		expect((await call("read_file", { path: f("c.pdf") })).text).toMatch(/read_pdf/);
	});
	test("rich text goes through textutil", async () => {
		const { call, bridge } = setup();
		bridge.existing.set(f("d.docx"), infoOf(f("d.docx")));
		const r = await call("read_file", { path: f("d.docx") });
		expect(r.text).toContain("rich text");
		expect(bridge.calls).toEqual([`rich ${f("d.docx")}`]);
	});
	test("latin1 fallback is reported", async () => {
		const { call, bridge } = setup();
		bridge.existing.set(f("l.txt"), infoOf(f("l.txt")));
		bridge.text = { kind: "text", text: "x", encoding: "latin1", size: 1 };
		expect((await call("read_file", { path: f("l.txt") })).text).toMatch(/Latin-1/);
	});
	test("output is capped at ~100 KB", async () => {
		const { call, bridge } = setup();
		bridge.existing.set(f("big.txt"), infoOf(f("big.txt")));
		const text = Array.from({ length: 5000 }, () => "x".repeat(99)).join("\n");
		bridge.text = { kind: "text", text, encoding: "utf-8", size: text.length };
		const r = await call("read_file", { path: f("big.txt") });
		expect(r.text.length).toBeLessThan(101_000 + 300);
		expect(r.text).toMatch(/Truncated/);
	});
	test("missing file", async () => {
		expect((await setup().call("read_file", { path: f("nope") })).isError).toBe(true);
	});
});

describe("write_file", () => {
	test("create fails when file exists, works otherwise", async () => {
		const { call, bridge } = setup();
		bridge.existing.set(f("e.txt"), infoOf(f("e.txt")));
		expect((await call("write_file", { path: f("e.txt"), content: "x" })).isError).toBe(true);
		expect((await call("write_file", { path: f("new.txt"), content: "x" })).isError).toBe(false);
		expect(bridge.calls).toEqual([`write create ${f("new.txt")} 1 false`]);
	});
	test("overwrite without confirm previews and changes nothing", async () => {
		const { call, bridge } = setup();
		bridge.existing.set(f("e.txt"), infoOf(f("e.txt"), { size: 42 }));
		const r = await call("write_file", { path: f("e.txt"), content: "new", mode: "overwrite" });
		expect(r.text).toMatch(/PREVIEW/);
		expect(r.text).toContain("42 bytes -> 3 bytes");
		expect(r.text).toContain("old line 1");
		expect(bridge.calls).toEqual([]);
	});
	test("overwrite with confirm writes", async () => {
		const { call, bridge } = setup();
		bridge.existing.set(f("e.txt"), infoOf(f("e.txt")));
		await call("write_file", { path: f("e.txt"), content: "new", mode: "overwrite", confirm: true });
		expect(bridge.calls).toEqual([`write overwrite ${f("e.txt")} 3 false`]);
	});
	test("overwrite of a missing file needs no confirm; append never does", async () => {
		const { call, bridge } = setup();
		await call("write_file", { path: f("n.txt"), content: "x", mode: "overwrite" });
		bridge.existing.set(f("e.txt"), infoOf(f("e.txt")));
		await call("write_file", { path: f("e.txt"), content: "x", mode: "append" });
		expect(bridge.calls).toHaveLength(2);
	});
	test("createDirs is passed through", async () => {
		const { call, bridge } = setup();
		await call("write_file", { path: f("sub/n.txt"), content: "x", createDirs: true });
		expect(bridge.calls[0]).toMatch(/ true$/);
	});
});

describe("move_file", () => {
	test("plain move needs no confirm (destination folder must exist)", async () => {
		const { call, bridge } = setup();
		bridge.existing.set(f("a"), infoOf(f("a")));
		const r = await call("move_file", { from: f("a"), to: f("b") });
		expect(r.isError).toBe(false);
		expect(bridge.calls).toEqual([`move ${f("a")} ${f("b")}`]);
	});
	test("onto existing target previews both, then moves with confirm", async () => {
		const { call, bridge } = setup();
		bridge.existing.set(f("a"), infoOf(f("a")));
		bridge.existing.set(f("b"), infoOf(f("b")));
		const p = await call("move_file", { from: f("a"), to: f("b") });
		expect(p.text).toMatch(/PREVIEW/);
		expect(p.text).toContain(f("a"));
		expect(p.text).toContain(f("b"));
		expect(bridge.calls).toEqual([]);
		await call("move_file", { from: f("a"), to: f("b"), confirm: true });
		expect(bridge.calls).toHaveLength(1);
	});
	test("rejects moving a file onto a folder path and a folder into itself", async () => {
		const { call, bridge } = setup();
		bridge.existing.set(f("a"), infoOf(f("a")));
		bridge.existing.set(f("dir"), infoOf(f("dir"), { type: "dir" }));
		expect((await call("move_file", { from: f("a"), to: f("dir"), confirm: true })).isError).toBe(true);
		expect((await call("move_file", { from: f("dir"), to: f("dir/x") })).isError).toBe(true);
		expect(bridge.calls).toEqual([]);
	});
});

describe("trash_file / create_folder", () => {
	test("trash is always confirm-gated", async () => {
		const { call, bridge } = setup();
		bridge.existing.set(f("a"), infoOf(f("a")));
		expect((await call("trash_file", { path: f("a") })).text).toMatch(/PREVIEW/);
		expect(bridge.calls).toEqual([]);
		const r = await call("trash_file", { path: f("a"), confirm: true });
		expect(r.text).toMatch(/Trash/);
		expect(bridge.calls).toEqual([`trash ${f("a")}`]);
	});
	test("create_folder is idempotent", async () => {
		const { call, bridge } = setup();
		await call("create_folder", { path: f("d") });
		bridge.existing.set(f("d"), infoOf(f("d"), { type: "dir" }));
		await call("create_folder", { path: f("d") });
		expect(bridge.calls).toEqual([`mkdir ${f("d")}`]);
	});
});

describe("get_file_info", () => {
	test("hides symlink targets outside the roots", async () => {
		const { call, bridge } = setup();
		bridge.existing.set(f("l"), infoOf(f("l"), { type: "symlink", symlinkTarget: "/etc/hosts" }));
		expect((await call("get_file_info", { path: f("l") })).text).toContain("outside allowed");
	});
});

describe("list_files with the real bridge", () => {
	test("sorts dirs first, filters, caps, and hides escaping symlinks", async () => {
		const outside = join(scratch, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "x.txt"), "x");
		mkdirSync(join(root, "zdir"));
		writeFileSync(join(root, "zdir", "deep.txt"), "d");
		writeFileSync(join(root, "a.txt"), "a");
		writeFileSync(join(root, "b.md"), "b");
		writeFileSync(join(root, ".hidden"), "h");
		symlinkSync(outside, join(root, "escape"));
		symlinkSync(join(root, "a.txt"), join(root, "good-link"));
		const mod = createFilesModule(filesBridge, policy);
		const run = async (args: object) => {
			const r = await mod.handle("list_files", { dir: root, ...args });
			const t = (r.content[0] as { text: string }).text;
			return JSON.parse(t.slice(t.indexOf("\n\n") + 2)) as { name: string; type: string }[];
		};
		const flat = await run({});
		expect(flat.map((e) => e.name)).toEqual(["zdir", "a.txt", "b.md", "good-link"]);
		expect(flat.find((e) => e.name === "good-link")?.type).toBe("symlink");
		expect((await run({ includeHidden: true })).map((e) => e.name)).toContain(".hidden");
		expect((await run({ pattern: "*.md" })).map((e) => e.name)).toEqual(["b.md"]);
		expect((await run({ depth: 1, pattern: "deep*" })).map((e) => e.name)).toEqual(["deep.txt"]);
		expect(await run({ limit: 2 })).toHaveLength(2);
	});
});

describe("real bridge writes (scratch dir only)", () => {
	test("create/append/overwrite/move/mkdir roundtrip", async () => {
		const dir = join(root, "rt");
		const p = join(dir, "f.txt");
		await filesBridge.mkdir(dir);
		await filesBridge.write(p, "one", "create", false);
		await expect(filesBridge.write(p, "x", "create", false)).rejects.toThrow();
		await filesBridge.write(p, "+two", "append", false);
		expect(await filesBridge.readText(p)).toMatchObject({ text: "one+two" });
		await filesBridge.write(p, "new", "overwrite", false);
		expect(await filesBridge.readText(p)).toMatchObject({ text: "new" });
		await filesBridge.move(p, join(dir, "g.txt"));
		expect(await filesBridge.info(p)).toBeNull();
		await expect(filesBridge.write(join(dir, "n/x"), "x", "create", false)).rejects.toThrow(
			/createDirs/,
		);
		writeFileSync(join(dir, "bin"), Buffer.from([1, 0, 2]));
		expect((await filesBridge.readText(join(dir, "bin"))).kind).toBe("binary");
	});
});

test("globToRegExp", () => {
	expect(globToRegExp("*.PDF").test("a.pdf")).toBe(true);
	expect(globToRegExp("a?c").test("abc")).toBe(true);
	expect(globToRegExp("a.c").test("abc")).toBe(false);
});
