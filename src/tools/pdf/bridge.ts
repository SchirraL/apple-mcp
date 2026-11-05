import { runJxa } from "../../lib/applescript.js";

// PDFKit via the JXA ObjC bridge. Measured: ~70ms to open, ~1-3ms per page of text
// extraction (838 pages / 2.5M chars in 2.7s), so no Spotlight/mdls fallback is needed
// and per-page boundaries are preserved. Paths must already be policy-checked.

export interface PdfInfo {
	pageCount: number;
	title: string | null;
	author: string | null;
	subject: string | null;
	keywords: string | null;
	creator: string | null;
	producer: string | null;
	/** ISO 8601, or null when absent. */
	created: string | null;
	modified: string | null;
	/** Document carries encryption (it opened, so it is readable). */
	encrypted: boolean;
	allowsCopying: boolean;
	/** True if any sampled page has extractable text. */
	hasTextLayer: boolean;
	/** 1-based page numbers that were sampled for the text-layer check. */
	sampledPages: number[];
}

export interface PdfPageText {
	/** 1-based page number. */
	page: number;
	text: string;
}

export interface PdfPages {
	pageCount: number;
	/** Consecutive pages starting at the requested `from`; stops once `maxChars` is reached. */
	pages: PdfPageText[];
}

export interface PdfMatch {
	page: number;
	snippet: string;
}

export interface PdfSearchResult {
	pageCount: number;
	matches: PdfMatch[];
	/** True if scanning stopped because `limit` was reached. */
	limitReached: boolean;
	/** 1-based page where scanning stopped when limitReached (matches may continue there). */
	stoppedAtPage: number | null;
}

export interface PdfBridge {
	info(path: string): Promise<PdfInfo>;
	readPages(path: string, from: number, to: number, maxChars: number): Promise<PdfPages>;
	search(
		path: string,
		query: string,
		opts: { limit: number; context: number; fromPage: number; toPage: number },
	): Promise<PdfSearchResult>;
}

type Failure = { error: "unreadable" | "locked" };

// Each function below is serialised with toString() and must be self-contained.

function infoJxa(args: { path: string }): PdfInfo | Failure {
	ObjC.import("PDFKit");
	const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(args.path));
	if (!doc || doc.isNil()) return { error: "unreadable" };
	if (doc.isLocked) return { error: "locked" };
	const n = Number(doc.pageCount);
	const attrs = doc.documentAttributes;
	const str = (key: string): string | null => {
		if (attrs.isNil()) return null;
		const v = attrs.objectForKey(key);
		if (!v || v.isNil()) return null;
		const s = String(ObjC.unwrap(v)).trim();
		return s ? s : null;
	};
	const date = (key: string): string | null => {
		if (attrs.isNil()) return null;
		const v = attrs.objectForKey(key);
		if (!v || v.isNil()) return null;
		const d = ObjC.deepUnwrap(v);
		return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
	};
	// Sample up to 5 pages spread across the document.
	const sampled: number[] = [];
	for (let k = 0; k < Math.min(5, n); k++) {
		const idx = n <= 5 ? k : Math.floor((k * (n - 1)) / 4);
		if (sampled.indexOf(idx + 1) === -1) sampled.push(idx + 1);
	}
	let hasText = false;
	for (const p of sampled) {
		const s = doc.pageAtIndex(p - 1).string;
		if (s && !s.isNil() && String(ObjC.unwrap(s)).trim()) {
			hasText = true;
			break;
		}
	}
	return {
		pageCount: n,
		title: str("Title"),
		author: str("Author"),
		subject: str("Subject"),
		keywords: str("Keywords"),
		creator: str("Creator"),
		producer: str("Producer"),
		created: date("CreationDate"),
		modified: date("ModDate"),
		encrypted: Boolean(doc.isEncrypted),
		allowsCopying: Boolean(doc.allowsCopying),
		hasTextLayer: hasText,
		sampledPages: sampled,
	};
}

function readJxa(args: {
	path: string;
	from: number;
	to: number;
	maxChars: number;
}): PdfPages | Failure {
	ObjC.import("PDFKit");
	const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(args.path));
	if (!doc || doc.isNil()) return { error: "unreadable" };
	if (doc.isLocked) return { error: "locked" };
	const n = Number(doc.pageCount);
	const last = Math.min(args.to, n);
	const pages: { page: number; text: string }[] = [];
	let total = 0;
	for (let p = args.from; p <= last; p++) {
		const s = doc.pageAtIndex(p - 1).string;
		const text = s && !s.isNil() ? String(ObjC.unwrap(s)) : "";
		pages.push({ page: p, text });
		total += text.length;
		if (total >= args.maxChars) break;
	}
	return { pageCount: n, pages };
}

function searchJxa(args: {
	path: string;
	query: string;
	limit: number;
	context: number;
	fromPage: number;
	toPage: number;
}): PdfSearchResult | Failure {
	ObjC.import("PDFKit");
	const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(args.path));
	if (!doc || doc.isNil()) return { error: "unreadable" };
	if (doc.isLocked) return { error: "locked" };
	const n = Number(doc.pageCount);
	const last = Math.min(args.toPage, n);
	const needle = args.query.toLowerCase();
	const matches: { page: number; snippet: string }[] = [];
	for (let p = args.fromPage; p <= last; p++) {
		const s = doc.pageAtIndex(p - 1).string;
		if (!s || s.isNil()) continue;
		const text = String(ObjC.unwrap(s));
		const lower = text.toLowerCase();
		// toLowerCase can change length for a few characters; only trust offsets if equal.
		const hay = lower.length === text.length ? lower : text;
		let at = hay.indexOf(needle);
		while (at !== -1) {
			const from = Math.max(0, at - args.context);
			const to = Math.min(text.length, at + needle.length + args.context);
			matches.push({
				page: p,
				snippet:
					(from > 0 ? "..." : "") +
					text.slice(from, to).replace(/\s+/g, " ").trim() +
					(to < text.length ? "..." : ""),
			});
			if (matches.length >= args.limit) {
				return { pageCount: n, matches, limitReached: true, stoppedAtPage: p };
			}
			at = hay.indexOf(needle, at + needle.length);
		}
	}
	return { pageCount: n, matches, limitReached: false, stoppedAtPage: null };
}

function unwrap<T>(r: T | Failure): T {
	if (r && typeof r === "object" && "error" in r) {
		const f = r as Failure;
		if (f.error === "locked") {
			throw new Error(
				"This PDF is password-protected (locked). Remove the password first; " +
					"password entry is not supported.",
			);
		}
		throw new Error("Could not open this file as a PDF (corrupt or not a PDF).");
	}
	return r as T;
}

const OPTS = { app: "PDFKit", timeoutMs: 60_000 };

export const pdfBridge: PdfBridge = {
	async info(path) {
		return unwrap(await runJxa(infoJxa, { path }, OPTS));
	},
	async readPages(path, from, to, maxChars) {
		return unwrap(await runJxa(readJxa, { path, from, to, maxChars }, OPTS));
	},
	async search(path, query, o) {
		return unwrap(await runJxa(searchJxa, { path, query, ...o }, OPTS));
	},
};
