// Pure phone helpers. bridge.ts duplicates this logic inside its self-contained JXA function
// (functions passed to runJxa cannot import) — keep the two in sync; tests cover this copy.

/** Keep digits and a single leading "+"; drop everything else. */
export function normalizePhone(raw: string): string {
	const trimmed = raw.trim();
	const digits = trimmed.replace(/\D/g, "");
	return trimmed.startsWith("+") ? `+${digits}` : digits;
}

const SUFFIX_LEN = 10;
const MIN_SUFFIX = 9;

/**
 * Do two phone numbers denote the same line? Equal digits match; otherwise the last
 * min(len, 10) digits must agree and be at least 9, so "+49 171 1234567" matches
 * "0171 1234567" while short local numbers need to be identical.
 */
export function phonesMatch(a: string, b: string): boolean {
	const da = normalizePhone(a).replace(/\D/g, "");
	const db = normalizePhone(b).replace(/\D/g, "");
	if (da === "" || db === "") return false;
	if (da === db) return true;
	const k = Math.min(da.length, db.length, SUFFIX_LEN);
	if (k < MIN_SUFFIX) return false;
	return da.slice(-k) === db.slice(-k);
}
