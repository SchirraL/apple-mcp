import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	expandHome,
	isAllowedPath,
	loadPolicy,
	PathPolicyError,
	resolveAllowedPath,
} from "../../src/lib/paths.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "apple-mcp-paths-")));
const root = join(scratch, "root");
const outside = join(scratch, "outside");
const secret = join(root, "secret");
mkdirSync(root);
mkdirSync(outside);
mkdirSync(secret);
symlinkSync(outside, join(root, "escape"));
symlinkSync(join(root, "inner"), join(root, "ok-link"));
mkdirSync(join(root, "inner"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const policy = loadPolicy({ APPLE_MCP_FILE_ROOTS: root, APPLE_MCP_FILE_DENY: secret });
const HOME = homedir();

describe("loadPolicy", () => {
	test("defaults to home as the only root", () => {
		const p = loadPolicy({});
		expect(p.roots).toEqual([realpathSync(HOME)]);
		expect(p.deny.some((d) => d.endsWith("/.ssh"))).toBe(true);
	});
	test("custom roots and deny from env (colon separated)", () => {
		const p = loadPolicy({ APPLE_MCP_FILE_ROOTS: `${root}:${outside}` });
		expect(p.roots).toEqual([root, outside]);
		expect(policy.deny).toContain(secret);
	});
	test("~ expansion", () => {
		expect(expandHome("~")).toBe(HOME);
		expect(expandHome("~/x")).toBe(join(HOME, "x"));
		expect(expandHome("a~b")).toBe("a~b");
	});
});

describe("resolveAllowedPath", () => {
	test("absolute path inside root", () => {
		expect(resolveAllowedPath(join(root, "a.txt"), "read", policy)).toBe(join(root, "a.txt"));
	});
	test("nonexistent leaf is allowed", () => {
		expect(resolveAllowedPath(join(root, "new/dir/f"), "write", policy)).toBe(
			join(root, "new/dir/f"),
		);
	});
	test("relative paths are relative to home", () => {
		const p = loadPolicy({});
		expect(resolveAllowedPath("Documents/x", "read", p)).toBe(
			join(realpathSync(HOME), "Documents/x"),
		);
		expect(resolveAllowedPath("~/Documents/x", "read", p)).toBe(
			join(realpathSync(HOME), "Documents/x"),
		);
	});
	test("outside the roots is rejected", () => {
		expect(() => resolveAllowedPath(join(outside, "x"), "read", policy)).toThrow(
			PathPolicyError,
		);
		expect(() => resolveAllowedPath("/etc/hosts", "read", policy)).toThrow(/outside/);
	});
	test(".. escapes are rejected", () => {
		expect(() => resolveAllowedPath(`${root}/../outside/x`, "read", policy)).toThrow(
			PathPolicyError,
		);
		expect(() => resolveAllowedPath(`${root}/inner/../../outside`, "read", policy)).toThrow(
			PathPolicyError,
		);
	});
	test(".. that stays inside is fine", () => {
		expect(resolveAllowedPath(`${root}/inner/../b`, "read", policy)).toBe(join(root, "b"));
	});
	test("denied dirs are blocked even inside a root", () => {
		expect(() => resolveAllowedPath(join(secret, "k"), "read", policy)).toThrow(/protected/);
		expect(() => resolveAllowedPath(secret, "write", policy)).toThrow(PathPolicyError);
	});
	test("default denies under home", () => {
		const p = loadPolicy({});
		expect(() => resolveAllowedPath("~/.ssh/id_ed25519", "read", p)).toThrow(/protected/);
		expect(() => resolveAllowedPath("~/Library/Keychains", "read", p)).toThrow(PathPolicyError);
	});
	test("symlink inside root pointing outside is denied", () => {
		expect(() => resolveAllowedPath(join(root, "escape"), "read", policy)).toThrow(
			PathPolicyError,
		);
		expect(() => resolveAllowedPath(join(root, "escape", "new.txt"), "write", policy)).toThrow(
			PathPolicyError,
		);
	});
	test("symlink staying inside root is allowed and canonicalised", () => {
		expect(resolveAllowedPath(join(root, "ok-link"), "read", policy)).toBe(join(root, "inner"));
	});
	test("invalid input", () => {
		expect(() => resolveAllowedPath("", "read", policy)).toThrow(/Invalid/);
		expect(() => resolveAllowedPath("a\0b", "read", policy)).toThrow(/Invalid/);
	});
});

describe("isAllowedPath", () => {
	test("matches the policy", () => {
		expect(isAllowedPath(join(root, "x"), policy)).toBe(true);
		expect(isAllowedPath(join(outside, "x"), policy)).toBe(false);
		expect(isAllowedPath(join(secret, "x"), policy)).toBe(false);
		expect(isAllowedPath(`${root}-sibling`, policy)).toBe(false);
	});
});
