import { describe, expect, test } from "bun:test";
import { escapeAppleScriptString } from "../../src/lib/applescript.js";

describe("escapeAppleScriptString", () => {
	test("leaves plain text untouched", () => {
		expect(escapeAppleScriptString("hello world")).toBe("hello world");
	});

	test("escapes double quotes", () => {
		expect(escapeAppleScriptString('say "hi"')).toBe('say \\"hi\\"');
	});

	test("escapes backslashes", () => {
		expect(escapeAppleScriptString("a\\b")).toBe("a\\\\b");
	});

	test("escapes backslash before quote without double-processing", () => {
		expect(escapeAppleScriptString('\\"')).toBe('\\\\\\"');
	});

	test("converts LF and CRLF newlines to \\n", () => {
		expect(escapeAppleScriptString("a\nb")).toBe("a\\nb");
		expect(escapeAppleScriptString("a\r\nb")).toBe("a\\nb");
	});

	test("handles empty string", () => {
		expect(escapeAppleScriptString("")).toBe("");
	});
});
