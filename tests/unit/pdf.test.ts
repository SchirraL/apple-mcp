import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolModule } from "../../src/lib/types.js";
import type {
	PdfBridge,
	PdfInfo,
	PdfPages,
	PdfSearchResult,
} from "../../src/tools/pdf/bridge.js";
import { createPdfModule } from "../../src/tools/pdf/handler.js";

let root: string;
let file: string;
const savedRoots = process.env.APPLE_MCP_FILE_ROOTS;

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "apple-mcp-pdf-")));
	file = join(root, "doc.pdf");
	writeFileSync(file, "%PDF-fake");
	mkdirSync(join(root, "dir"));
	process.env.APPLE_MCP_FILE_ROOTS = root;
});
afterAll(() => {
	if (savedRoots === undefined) delete process.env.APPLE_MCP_FILE_ROOTS;
	else process.env.APPLE_MCP_FILE_ROOTS = savedRoots;
	rmSync(root, { recursive: true, force: true });
});

class FakeBridge implements PdfBridge {
	calls: { method: string; args: unknown[] }[] = [];
	error: Error | null = null;
	pageCount = 10;
	texts: Record<number, string> = {};
	info_: Partial<PdfInfo> = {};
	searchResult: PdfSearchResult | null = null;

	private text(p: number): string {
		return this.texts[p] ?? `text of page ${p}`;
	}
	async info(path: string): Promise<PdfInfo> {
		this.calls.push({ method: "info", args: [path] });
		if (this.error) throw this.error;
		return {
			pageCount: this.pageCount,
			title: "T",
			author: null,
			subject: null,
			keywords: null,
			creator: null,
			producer: null,
			created: "2020-01-01T00:00:00.000Z",
			modified: null,
			encrypted: false,
			allowsCopying: true,
			hasTextLayer: true,
			sampledPages: [1, 5, 10],
			...this.info_,
		};
	}
	async readPages(path: string, from: number, to: number, maxChars: number): Promise<PdfPages> {
		this.calls.push({ method: "readPages", args: [path, from, to, maxChars] });
		if (this.error) throw this.error;
		const pages = [];
		let total = 0;
		for (let p = from; p <= Math.min(to, this.pageCount); p++) {
			pages.push({ page: p, text: this.text(p) });
			total += this.text(p).length;
			if (total >= maxChars) break;
		}
		return { pageCount: this.pageCount, pages };
	}
	async search(path: string, query: string, o: unknown): Promise<PdfSearchResult> {
		this.calls.push({ method: "search", args: [path, query, o] });
		if (this.error) throw this.error;
		return (
			this.searchResult ?? {
				pageCount: this.pageCount,
				matches: [{ page: 2, snippet: "...foo bar..." }],
				limitReached: false,
				stoppedAtPage: null,
			}
		);
	}
}

let bridge: FakeBridge;
let mod: ToolModule;
beforeEach(() => {
	bridge = new FakeBridge();
	mod = createPdfModule(bridge);
});

const text = (r: { content: { type: string; text?: string }[] }): string => r.content[0]?.text ?? "";

describe("tool list", () => {
	test("exposes the three tools with schemas", () => {
		expect(mod.tools.map((t) => t.name).sort()).toEqual(["get_pdf_info", "read_pdf", "search_pdf"]);
	});
});

describe("path policy", () => {
	test("rejects paths outside the allowed roots without touching the bridge", async () => {
		const r = await mod.handle("read_pdf", { path: "/etc/hosts" });
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("outside the allowed roots");
		expect(bridge.calls).toHaveLength(0);
	});
	test("missing file and directory give clear errors", async () => {
		const missing = await mod.handle("get_pdf_info", { path: join(root, "nope.pdf") });
		expect(text(missing)).toContain("File not found");
		const dir = await mod.handle("get_pdf_info", { path: join(root, "dir") });
		expect(text(dir)).toContain("Not a file");
		expect(bridge.calls).toHaveLength(0);
	});
	test("all three tools enforce the policy", async () => {
		for (const name of ["read_pdf", "get_pdf_info", "search_pdf"]) {
			const r = await mod.handle(name, { path: "/etc/hosts", query: "x" });
			expect(r.isError).toBe(true);
		}
		expect(bridge.calls).toHaveLength(0);
	});
});

describe("read_pdf", () => {
	test("returns page markers and totals", async () => {
		bridge.pageCount = 3;
		const r = await mod.handle("read_pdf", { path: file });
		const t = text(r);
		expect(r.isError).toBeUndefined();
		expect(t).toContain("3 pages total. Showing pages 1-3");
		expect(t).toContain("--- Page 1 ---\ntext of page 1");
		expect(t).toContain("--- Page 3 ---");
		expect(t).not.toContain("TRUNCATED");
	});
	test("passes the page range through and clamps", async () => {
		await mod.handle("read_pdf", { path: file, fromPage: 4, toPage: 5 });
		expect(bridge.calls[0]?.args.slice(1, 3)).toEqual([4, 5]);
		const r = await mod.handle("read_pdf", { path: file, fromPage: 9, toPage: 99 });
		expect(text(r)).toContain("Showing pages 9-10");
	});
	test("fromPage beyond the end and inverted range are errors", async () => {
		const a = await mod.handle("read_pdf", { path: file, fromPage: 11 });
		expect(a.isError).toBe(true);
		expect(text(a)).toContain("has 10 pages");
		const b = await mod.handle("read_pdf", { path: file, fromPage: 5, toPage: 2 });
		expect(b.isError).toBe(true);
	});
	test("truncates on page boundary and says where to continue", async () => {
		for (let p = 1; p <= 10; p++) bridge.texts[p] = "x".repeat(400);
		const r = await mod.handle("read_pdf", { path: file, maxChars: 1000 });
		const t = text(r);
		expect(t).toContain("TRUNCATED at maxChars=1000");
		expect(t).toContain("Continue with fromPage=3");
		expect(t).toContain("--- Page 2 ---");
		expect(t).not.toContain("--- Page 3 ---");
	});
	test("a single oversized page is cut and continues at the next page", async () => {
		bridge.texts[1] = "y".repeat(5000);
		const r = await mod.handle("read_pdf", { path: file, maxChars: 1000 });
		const t = text(r);
		expect(t).toContain("last shown page was cut");
		expect(t).toContain("Continue with fromPage=2");
		expect(t.length).toBeLessThan(2000);
	});
	test("no truncation notice when the range ends exactly", async () => {
		const r = await mod.handle("read_pdf", { path: file, fromPage: 1, toPage: 2 });
		expect(text(r)).not.toContain("TRUNCATED");
	});
	test("scanned PDF is reported explicitly", async () => {
		bridge.pageCount = 2;
		bridge.texts = { 1: "", 2: "  " };
		const t = text(await mod.handle("read_pdf", { path: file }));
		expect(t).toContain("scanned/image-only");
		expect(t).toContain("OCR is not supported");
	});
	test("partially empty pages are listed", async () => {
		bridge.pageCount = 3;
		bridge.texts = { 2: "" };
		const t = text(await mod.handle("read_pdf", { path: file }));
		expect(t).toContain("1 page(s) have no extractable text (2)");
	});
	test("locked PDF error is surfaced", async () => {
		bridge.error = new Error("This PDF is password-protected (locked).");
		const r = await mod.handle("read_pdf", { path: file });
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("password-protected");
	});
	test("validates arguments", async () => {
		expect((await mod.handle("read_pdf", { path: file, fromPage: 0 })).isError).toBe(true);
		expect((await mod.handle("read_pdf", { path: file, maxChars: 5 })).isError).toBe(true);
		expect((await mod.handle("read_pdf", {})).isError).toBe(true);
	});
});

describe("get_pdf_info", () => {
	test("returns metadata plus file size", async () => {
		const r = await mod.handle("get_pdf_info", { path: file });
		const t = text(r);
		expect(t).toContain("PDF with 10 pages.");
		const json = JSON.parse(t.slice(t.indexOf("{")));
		expect(json.fileSizeBytes).toBe(9);
		expect(json.title).toBe("T");
		expect(json.hasTextLayer).toBe(true);
		expect(json.textLayerSampledPages).toEqual([1, 5, 10]);
	});
	test("flags a missing text layer", async () => {
		bridge.info_ = { hasTextLayer: false };
		expect(text(await mod.handle("get_pdf_info", { path: file }))).toContain("likely scanned");
	});
});

describe("search_pdf", () => {
	test("passes options and reports matches", async () => {
		const r = await mod.handle("search_pdf", { path: file, query: "foo", limit: 5 });
		expect(bridge.calls[0]?.args[2]).toMatchObject({ limit: 5, context: 80, fromPage: 1 });
		expect(text(r)).toContain("1 match(es) on 1 page(s) of 10");
		expect(text(r)).toContain("foo bar");
	});
	test("limit reached says how to continue", async () => {
		bridge.searchResult = {
			pageCount: 10,
			matches: [{ page: 4, snippet: "a" }],
			limitReached: true,
			stoppedAtPage: 4,
		};
		expect(text(await mod.handle("search_pdf", { path: file, query: "a", limit: 1 }))).toContain(
			"fromPage=5",
		);
	});
	test("no matches mentions scanned PDFs", async () => {
		bridge.searchResult = { pageCount: 1, matches: [], limitReached: false, stoppedAtPage: null };
		expect(text(await mod.handle("search_pdf", { path: file, query: "zzz" }))).toContain(
			"0 match(es)",
		);
	});
	test("empty query is rejected", async () => {
		expect((await mod.handle("search_pdf", { path: file, query: "" })).isError).toBe(true);
	});
});
