import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolModule } from "../../src/lib/types.js";
import {
	createShortcutsBridge,
	type ExecFn,
	parseIdentifierLines,
	type RunRequest,
	type RunResult,
	type ShortcutCatalog,
	type ShortcutsBridge,
} from "../../src/tools/shortcuts/bridge.js";
import { createShortcutsModule } from "../../src/tools/shortcuts/handler.js";

const ID1 = "11111111-1111-1111-1111-111111111111";
const ID2 = "22222222-2222-2222-2222-222222222222";
const ID3 = "33333333-3333-3333-3333-333333333333";
const ID4 = "44444444-4444-4444-4444-444444444444";
const FID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";

const CATALOG: ShortcutCatalog = {
	folders: [{ name: "Work", identifier: FID }],
	shortcuts: [
		{ name: "apple-mcp-test", identifier: ID1, folder: null },
		{ name: "Daily Report", identifier: ID2, folder: "Work" },
		{ name: "Dup", identifier: ID3, folder: null },
		{ name: "Dup", identifier: ID4, folder: "Work" },
	],
};

class FakeBridge implements ShortcutsBridge {
	runs: RunRequest[] = [];
	views: string[] = [];
	result: RunResult = {
		exitCode: 0,
		timedOut: false,
		stdout: "",
		stderr: "",
		output: { kind: "text", text: "hello", truncated: false, chars: 5 },
	};
	async catalog(): Promise<ShortcutCatalog> {
		return CATALOG;
	}
	async run(req: RunRequest): Promise<RunResult> {
		this.runs.push(req);
		return this.result;
	}
	async view(name: string): Promise<void> {
		this.views.push(name);
	}
}

function text(r: { content: unknown }): string {
	return (r.content as { text: string }[])[0]!.text;
}

let root: string;
let file: string;
const savedRoots = process.env.APPLE_MCP_FILE_ROOTS;
beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "apple-mcp-sc-")));
	file = join(root, "in.txt");
	writeFileSync(file, "x");
	process.env.APPLE_MCP_FILE_ROOTS = root;
});
afterAll(() => {
	if (savedRoots === undefined) delete process.env.APPLE_MCP_FILE_ROOTS;
	else process.env.APPLE_MCP_FILE_ROOTS = savedRoots;
	rmSync(root, { recursive: true, force: true });
});

function setup(env: NodeJS.ProcessEnv = {}): { b: FakeBridge; m: ToolModule } {
	const b = new FakeBridge();
	return { b, m: createShortcutsModule(b, env) };
}

describe("tool list", () => {
	test("exposes the three tools", () => {
		expect(setup().m.tools.map((t) => t.name)).toEqual([
			"list_shortcuts",
			"run_shortcut",
			"view_shortcut",
		]);
	});
});

describe("list_shortcuts", () => {
	test("filters by folder, query and limit", async () => {
		const { m } = setup();
		const a = text(await m.handle("list_shortcuts", { folder: "work" }));
		expect(a).toContain("Daily Report");
		expect(a).not.toContain("apple-mcp-test");
		const none = text(await m.handle("list_shortcuts", { folder: "none" }));
		expect(none).toContain("apple-mcp-test");
		expect(none).not.toContain("Daily Report");
		const q = text(await m.handle("list_shortcuts", { query: "REPORT" }));
		expect(q).toContain("1 shortcut(s)");
		const l = text(await m.handle("list_shortcuts", { limit: 2 }));
		expect(l).toContain("showing the first 2");
	});
	test("unknown folder is an error; includeFolders returns folders", async () => {
		const { m } = setup();
		expect((await m.handle("list_shortcuts", { folder: "nope" })).isError).toBe(true);
		expect(text(await m.handle("list_shortcuts", { includeFolders: true }))).toContain(
			'"folders"',
		);
	});
});

describe("run_shortcut", () => {
	test("without confirm: preview only, nothing runs", async () => {
		const { b, m } = setup();
		const r = await m.handle("run_shortcut", { name: "daily report", input: "hi" });
		expect(r.isError).toBeUndefined();
		expect(text(r)).toContain("PREVIEW");
		expect(text(r)).toContain(ID2);
		expect(text(r)).toContain("Work");
		expect(text(r)).toContain('"hi"');
		expect(b.runs).toHaveLength(0);
	});
	test("confirm runs by identifier with input and returns text output", async () => {
		const { b, m } = setup();
		const r = await m.handle("run_shortcut", {
			name: "Daily Report",
			input: "hi",
			confirm: true,
			timeoutSeconds: 5,
		});
		expect(text(r)).toContain("hello");
		expect(b.runs[0]).toMatchObject({
			identifier: ID2,
			inputText: "hi",
			captureOutput: true,
			timeoutMs: 5000,
		});
	});
	test("default timeout 60s, max 300s enforced", async () => {
		const { b, m } = setup();
		await m.handle("run_shortcut", { name: ID1, confirm: true });
		expect(b.runs[0]!.timeoutMs).toBe(60_000);
		const bad = await m.handle("run_shortcut", { name: ID1, timeoutSeconds: 301 });
		expect(bad.isError).toBe(true);
	});
	test("unknown name lists close matches, no auto-pick", async () => {
		const { b, m } = setup();
		const r = await m.handle("run_shortcut", { name: "daily", confirm: true });
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("Close matches");
		expect(text(r)).toContain("Daily Report");
		expect(b.runs).toHaveLength(0);
	});
	test("unknown with no matches points to list_shortcuts", async () => {
		const { m } = setup();
		const r = await m.handle("run_shortcut", { name: "zzzzqq", confirm: true });
		expect(text(r)).toContain("list_shortcuts");
	});
	test("ambiguous name errors with identifiers; identifier disambiguates", async () => {
		const { b, m } = setup();
		const r = await m.handle("run_shortcut", { name: "dup", confirm: true });
		expect(r.isError).toBe(true);
		expect(text(r)).toContain(ID3);
		expect(text(r)).toContain(ID4);
		expect(b.runs).toHaveLength(0);
		await m.handle("run_shortcut", { name: ID4, confirm: true });
		expect(b.runs[0]!.identifier).toBe(ID4);
	});
	test("allowlist (name or id, case-insensitive) skips confirm", async () => {
		const byName = setup({ APPLE_MCP_SHORTCUTS_ALLOW: " Apple-MCP-Test , other" });
		const r = await byName.m.handle("run_shortcut", { name: "apple-mcp-test" });
		expect(text(r)).toContain("Ran shortcut");
		expect(byName.b.runs).toHaveLength(1);
		const byId = setup({ APPLE_MCP_SHORTCUTS_ALLOW: ID2.toLowerCase() });
		await byId.m.handle("run_shortcut", { name: "Daily Report" });
		expect(byId.b.runs).toHaveLength(1);
		const notListed = setup({ APPLE_MCP_SHORTCUTS_ALLOW: "apple-mcp-test" });
		await notListed.m.handle("run_shortcut", { name: "Daily Report" });
		expect(notListed.b.runs).toHaveLength(0);
	});
	test("input and inputPath are mutually exclusive", async () => {
		const { m } = setup();
		const r = await m.handle("run_shortcut", {
			name: ID1,
			input: "a",
			inputPath: file,
			confirm: true,
		});
		expect(r.isError).toBe(true);
	});
	test("inputPath goes through the path policy", async () => {
		const { b, m } = setup();
		const ok = await m.handle("run_shortcut", { name: ID1, inputPath: file, confirm: true });
		expect(ok.isError).toBeUndefined();
		expect(b.runs[0]!.inputPath).toBe(file);
		const prev = await m.handle("run_shortcut", { name: ID1, inputPath: file });
		expect(text(prev)).toContain(file);
		for (const p of ["/etc/hosts", join(root, "missing.txt"), root]) {
			const r = await m.handle("run_shortcut", { name: ID1, inputPath: p, confirm: true });
			expect(r.isError).toBe(true);
		}
		expect(b.runs).toHaveLength(1);
	});
	test("non-text output reports path and type", async () => {
		const { b, m } = setup();
		b.result = {
			...b.result,
			output: { kind: "file", path: "/tmp/x/output", type: "public.png", bytes: 10 },
		};
		const r = await m.handle("run_shortcut", { name: ID1, confirm: true });
		expect(text(r)).toContain("/tmp/x/output");
		expect(text(r)).toContain("public.png");
	});
	test("timeout and failure are errors", async () => {
		const { b, m } = setup();
		b.result = { ...b.result, timedOut: true, exitCode: null, output: null };
		const t = await m.handle("run_shortcut", { name: ID1, confirm: true });
		expect(t.isError).toBe(true);
		expect(text(t)).toContain("timed out");
		b.result = { ...b.result, timedOut: false, exitCode: 1, stderr: "boom" };
		const f = await m.handle("run_shortcut", { name: ID1, confirm: true });
		expect(text(f)).toContain("boom");
	});
});

describe("view_shortcut", () => {
	test("opens by resolved name", async () => {
		const { b, m } = setup();
		await m.handle("view_shortcut", { name: ID2 });
		expect(b.views).toEqual(["Daily Report"]);
	});
	test("duplicate names cannot be viewed", async () => {
		const { b, m } = setup();
		const r = await m.handle("view_shortcut", { name: ID3 });
		expect(r.isError).toBe(true);
		expect(b.views).toHaveLength(0);
	});
});

describe("real bridge with injected exec and clock", () => {
	function fakeExec(calls: string[][]): ExecFn {
		return async (args) => {
			calls.push(args);
			const joined = args.join(" ");
			let stdout = "";
			if (joined === "list --show-identifiers") stdout = `A (b) c (${ID1})\nD (${ID2})\n`;
			else if (joined === "list --folders --show-identifiers") stdout = `Work (${FID})\n`;
			else if (joined.startsWith("list --folder-name")) stdout = `D (${ID2})\n`;
			return { code: 0, timedOut: false, stdout, stderr: "" };
		};
	}
	test("parses names containing parentheses", () => {
		expect(parseIdentifierLines(`A (b) c (${ID1})\njunk\n`)).toEqual([
			{ name: "A (b) c", identifier: ID1 },
		]);
	});
	test("catalog assigns folders and is cached for the TTL", async () => {
		const calls: string[][] = [];
		let t = 1000;
		const bridge = createShortcutsBridge({ exec: fakeExec(calls), now: () => t });
		const c1 = await bridge.catalog();
		expect(c1.shortcuts.map((s) => s.folder)).toEqual([null, "Work"]);
		const n = calls.length;
		t += 29_000;
		await bridge.catalog();
		expect(calls.length).toBe(n);
		t += 2_000;
		await bridge.catalog();
		expect(calls.length).toBe(n * 2);
		await bridge.catalog(true);
		expect(calls.length).toBe(n * 3);
	});
	test("concurrent calls share one load", async () => {
		const calls: string[][] = [];
		const bridge = createShortcutsBridge({ exec: fakeExec(calls), now: () => 0 });
		const [a, b] = await Promise.all([bridge.catalog(), bridge.catalog()]);
		expect(a).toBe(b);
		expect(calls.length).toBe(3);
	});
	test("list failure surfaces stderr", async () => {
		const bridge = createShortcutsBridge({
			exec: async () => ({ code: 1, timedOut: false, stdout: "", stderr: "denied" }),
		});
		await expect(bridge.catalog()).rejects.toThrow("denied");
	});
	test("run writes input temp file, reads text output, cleans up", async () => {
		let inPath = "";
		let content = "";
		const { readFileSync, existsSync } = await import("node:fs");
		const bridge = createShortcutsBridge({
			exec: async (args) => {
				inPath = args[args.indexOf("--input-path") + 1]!;
				content = readFileSync(inPath, "utf8");
				writeFileSync(args[args.indexOf("--output-path") + 1]!, "echo:" + content);
				return { code: 0, timedOut: false, stdout: "", stderr: "" };
			},
		});
		const r = await bridge.run({
			identifier: ID1,
			inputText: "ping",
			captureOutput: true,
			timeoutMs: 1000,
		});
		expect(content).toBe("ping");
		expect(r.output).toMatchObject({ kind: "text", text: "echo:ping" });
		expect(existsSync(inPath)).toBe(false);
	});
	test("run keeps binary output file and reports type", async () => {
		const { existsSync, rmSync: rm } = await import("node:fs");
		const bridge = createShortcutsBridge({
			exec: async (args) => {
				writeFileSync(
					args[args.indexOf("--output-path") + 1]!,
					Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]),
				);
				return { code: 0, timedOut: false, stdout: "", stderr: "" };
			},
		});
		const r = await bridge.run({ identifier: ID1, captureOutput: true, timeoutMs: 1000 });
		expect(r.output).toMatchObject({ kind: "file", type: "public.png", bytes: 7 });
		if (r.output?.kind === "file") {
			expect(existsSync(r.output.path)).toBe(true);
			rm(join(r.output.path, ".."), { recursive: true, force: true });
		}
	});
});
