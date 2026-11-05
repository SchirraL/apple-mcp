import { statSync } from "node:fs";
import { z } from "zod";
import { PathPolicyError, resolveAllowedPath } from "../../lib/paths.js";
import {
	dataResult,
	defineTool,
	textResult,
	type ToolModule,
	toolModule,
} from "../../lib/types.js";
import { type PdfBridge, pdfBridge } from "./bridge.js";

const DEFAULT_MAX_CHARS = 100_000;
const OCR_NOTE =
	"OCR is not supported yet, so image-only (scanned) pages cannot be read by this tool.";

const pathField = z
	.string()
	.min(1)
	.describe("Path to the PDF file: absolute, ~/..., or relative to the home directory");

/** Resolve under the read policy and check it is an existing regular file. */
function resolvePdf(input: string): { path: string; size: number } {
	let path: string;
	try {
		path = resolveAllowedPath(input, "read");
	} catch (e) {
		if (e instanceof PathPolicyError) throw new Error(e.message);
		throw e;
	}
	let st: ReturnType<typeof statSync>;
	try {
		st = statSync(path);
	} catch {
		throw new Error(`File not found: ${path}`);
	}
	if (!st.isFile()) throw new Error(`Not a file: ${path}`);
	return { path, size: st.size };
}

function checkRange(from: number, to: number | undefined): void {
	if (to !== undefined && to < from) throw new Error("'toPage' must be >= 'fromPage'.");
}

export function createPdfModule(bridge: PdfBridge = pdfBridge): ToolModule {
	return toolModule([
		defineTool({
			name: "read_pdf",
			effect: "read",
			description:
				"Extract the text of a PDF file, page by page, with '--- Page N ---' markers and " +
				"the total page count. Use fromPage/toPage (1-based) to read a range. Output is " +
				"capped at maxChars; if truncated, the result says which page to continue from. " +
				"Locked PDFs return an error; scanned PDFs without a text layer are reported " +
				"explicitly (OCR is not supported). Use get_pdf_info for metadata only.",
			schema: z.object({
				path: pathField,
				fromPage: z.number().int().min(1).default(1).describe("First page (1-based)"),
				toPage: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Last page, inclusive (default: through the end)"),
				maxChars: z
					.number()
					.int()
					.min(1000)
					.max(1_000_000)
					.default(DEFAULT_MAX_CHARS)
					.describe("Maximum characters of text to return"),
			}),
			async run(args) {
				const { path } = resolvePdf(args.path);
				checkRange(args.fromPage, args.toPage);
				const res = await bridge.readPages(
					path,
					args.fromPage,
					args.toPage ?? Number.MAX_SAFE_INTEGER,
					args.maxChars,
				);
				if (args.fromPage > res.pageCount) {
					throw new Error(
						`fromPage ${args.fromPage} is beyond the end: the PDF has ${res.pageCount} pages.`,
					);
				}
				const lastWanted = Math.min(args.toPage ?? res.pageCount, res.pageCount);

				const out: string[] = [];
				let used = 0;
				let included = 0;
				let continueFrom: number | null = null;
				let cutMidPage = false;
				const emptyPages: number[] = [];
				for (const p of res.pages) {
					const text = p.text.trim();
					const block = `--- Page ${p.page} ---\n${text}\n`;
					if (included > 0 && used + block.length > args.maxChars) {
						continueFrom = p.page;
						break;
					}
					if (block.length > args.maxChars) {
						out.push(`${block.slice(0, args.maxChars)}\n[page cut at maxChars]\n`);
						used += args.maxChars;
						cutMidPage = true;
					} else {
						out.push(block);
						used += block.length;
					}
					included++;
					if (!text) emptyPages.push(p.page);
					if (cutMidPage) {
						if (p.page < lastWanted) continueFrom = p.page + 1;
						break;
					}
				}
				if (continueFrom === null && included === res.pages.length) {
					const lastIncluded = res.pages[res.pages.length - 1]?.page ?? args.fromPage - 1;
					if (lastIncluded < lastWanted) continueFrom = lastIncluded + 1;
				}

				const first = res.pages[0]?.page ?? args.fromPage;
				const lastShown = first + included - 1;
				const header: string[] = [
					`PDF: ${res.pageCount} pages total. Showing pages ${first}-${lastShown} ` +
						`(${used} chars).`,
				];
				if (continueFrom !== null) {
					header.push(
						`TRUNCATED at maxChars=${args.maxChars}${
							cutMidPage ? " (the last shown page was cut)" : ""
						}. Continue with fromPage=${continueFrom}.`,
					);
				}
				if (emptyPages.length > 0) {
					const allEmpty = emptyPages.length === included;
					header.push(
						allEmpty
							? `WARNING: none of the shown pages has extractable text; this looks like a ` +
									`scanned/image-only PDF. ${OCR_NOTE}`
							: `Note: ${emptyPages.length} page(s) have no extractable text ` +
									`(${emptyPages.slice(0, 20).join(", ")}${
										emptyPages.length > 20 ? ", ..." : ""
									}); they may be scanned images. ${OCR_NOTE}`,
					);
				}
				return textResult(`${header.join("\n")}\n\n${out.join("\n")}`);
			},
		}),

		defineTool({
			name: "get_pdf_info",
			effect: "read",
			description:
				"Get PDF metadata without reading the full text: page count, title, author, " +
				"subject, keywords, creator, producer, creation/modification dates, encrypted " +
				"flag, file size, and whether the PDF has a text layer (sampled from a few " +
				"pages; false suggests a scanned document).",
			schema: z.object({ path: pathField }),
			async run(args) {
				const { path, size } = resolvePdf(args.path);
				const info = await bridge.info(path);
				const { sampledPages, ...rest } = info;
				const data = { path, fileSizeBytes: size, ...rest, textLayerSampledPages: sampledPages };
				const note = info.hasTextLayer
					? ""
					: ` No text found on sampled pages; likely scanned. ${OCR_NOTE}`;
				return dataResult(`PDF with ${info.pageCount} pages.${note}`, data);
			},
		}),

		defineTool({
			name: "search_pdf",
			effect: "read",
			description:
				"Case-insensitive plain-text search inside one PDF. Returns page numbers with " +
				"short context snippets (one entry per occurrence), up to `limit`. Use read_pdf " +
				"with a page range to read the surrounding text.",
			schema: z.object({
				path: pathField,
				query: z.string().min(1).describe("Text to find (literal, not a regex)"),
				limit: z.number().int().min(1).max(200).default(20).describe("Max matches"),
				contextChars: z
					.number()
					.int()
					.min(0)
					.max(500)
					.default(80)
					.describe("Characters of context on each side of a match"),
				fromPage: z.number().int().min(1).default(1).describe("First page to search"),
				toPage: z.number().int().min(1).optional().describe("Last page to search"),
			}),
			async run(args) {
				const { path } = resolvePdf(args.path);
				checkRange(args.fromPage, args.toPage);
				const res = await bridge.search(path, args.query, {
					limit: args.limit,
					context: args.contextChars,
					fromPage: args.fromPage,
					toPage: args.toPage ?? Number.MAX_SAFE_INTEGER,
				});
				const pages = [...new Set(res.matches.map((m) => m.page))];
				let summary = `${res.matches.length} match(es) on ${pages.length} page(s) of ${res.pageCount}.`;
				if (res.limitReached) {
					summary += ` Limit ${args.limit} reached while scanning page ${res.stoppedAtPage}; later matches not shown (raise limit, or continue with fromPage=${res.stoppedAtPage! + 1}; any remaining matches on page ${res.stoppedAtPage} are skipped).`;
				}
				if (res.matches.length === 0) {
					summary += " If the PDF is scanned (no text layer), search cannot find text. " + OCR_NOTE;
				}
				return dataResult(summary, res.matches);
			},
		}),
	]);
}

