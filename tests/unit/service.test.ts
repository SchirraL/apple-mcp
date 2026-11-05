import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	unknownArgs,
	claudeCodeCommand,
	collectPlistEnv,
	desktopConfig,
	generatePlist,
	pinNode,
	plistNodePath,
	stabiliseNodePath,
	summariseLaunchctl,
	tail,
	xmlEscape,
} from "../../scripts/service.js";

const base = {
	label: "io.schirra.apple-mcp",
	nodePath: "/opt/homebrew/bin/node",
	scriptPath: "/repo/dist/index.js",
	workingDirectory: "/repo",
	logDir: "/logs",
};

describe("generatePlist", () => {
	test("contains required keys and arguments", () => {
		const plist = generatePlist(base);
		expect(plist).toContain("<string>io.schirra.apple-mcp</string>");
		expect(plist).toContain("<string>--http</string>");
		expect(plist).toContain("<key>RunAtLoad</key>\n\t<true/>");
		expect(plist).toContain("<key>SuccessfulExit</key>");
		expect(plist).toContain("<integer>10</integer>");
		expect(plist).toContain("/logs/stdout.log");
		expect(plist).toContain("/logs/stderr.log");
		expect(plist).not.toContain("APPLE_MCP_PORT");
	});
	test("includes port when set", () => {
		expect(generatePlist({ ...base, port: "5000" })).toContain(
			"<key>APPLE_MCP_PORT</key>\n\t\t<string>5000</string>",
		);
	});
	test("escapes XML in paths", () => {
		const plist = generatePlist({ ...base, workingDirectory: `/a&b/<c>"d"'e'` });
		expect(plist).toContain("/a&amp;b/&lt;c&gt;&quot;d&quot;&apos;e&apos;");
		expect(plist).not.toContain("/a&b/");
	});
	test("never contains a token", () => {
		expect(generatePlist(base).toLowerCase()).not.toContain("token");
		expect(generatePlist(base)).not.toContain("Bearer");
	});
	test("xmlEscape", () => {
		expect(xmlEscape("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&apos;");
	});
});

describe("stabiliseNodePath", () => {
	const cellar = "/opt/homebrew/Cellar/node/22.1.0/bin/node";
	test("keeps non-Cellar paths", () => {
		expect(stabiliseNodePath("/usr/local/bin/node", () => true)).toEqual({
			path: "/usr/local/bin/node",
		});
	});
	test("maps Cellar path to symlink with warning", () => {
		const r = stabiliseNodePath(cellar, (p) => p === "/opt/homebrew/bin/node");
		expect(r.path).toBe("/opt/homebrew/bin/node");
		expect(r.warning).toContain("re-granting");
	});
	test("intel prefix prefers /usr/local", () => {
		const r = stabiliseNodePath("/usr/local/Cellar/node/22/bin/node", () => true);
		expect(r.path).toBe("/usr/local/bin/node");
	});
	test("falls back to Cellar path when no symlink exists", () => {
		expect(stabiliseNodePath(cellar, () => false)).toEqual({ path: cellar });
	});
});

describe("config and parsing helpers", () => {
	test("claudeCodeCommand", () => {
		expect(claudeCodeCommand("http://127.0.0.1:1/mcp", "tok")).toBe(
			'claude mcp add --transport http --scope user apple-mcp http://127.0.0.1:1/mcp ' +
				'--header "Authorization: Bearer tok"',
		);
	});
	test("desktopConfig has no token", () => {
		const cfg = JSON.parse(desktopConfig("/n", "/b.js"));
		expect(cfg.mcpServers["apple-mcp"]).toEqual({ command: "/n", args: ["/b.js"] });
	});
	test("summariseLaunchctl", () => {
		const out = "x = {\n\tstate = running\n\tpid = 123\n\tlast exit code = 0\n}";
		expect(summariseLaunchctl(out)).toEqual({ state: "running", pid: "123", lastExit: "0" });
	});
	test("tail", () => {
		expect(tail("a\nb\nc\n", 2)).toBe("b\nc");
	});
});

describe("plist environment", () => {
	test("includes APPLE_MCP_* but never the token or other vars", () => {
		const plist = generatePlist({
			...base,
			env: { APPLE_MCP_FILE_ROOTS: "/a:/b", APPLE_MCP_TOKEN: "secret", HOME: "/h", FOO: "x" },
		});
		expect(plist).toContain("<key>APPLE_MCP_FILE_ROOTS</key>\n\t\t<string>/a:/b</string>");
		expect(plist).not.toContain("secret");
		expect(plist).not.toContain("APPLE_MCP_TOKEN");
		expect(plist).not.toContain("<key>HOME</key>");
		expect(plist).not.toContain("FOO");
	});
	test("escapes values", () => {
		const plist = generatePlist({ ...base, env: { APPLE_MCP_FILE_DENY: `<a&"b">` } });
		expect(plist).toContain("&lt;a&amp;&quot;b&quot;&gt;");
	});
	test("port is not duplicated when also in env", () => {
		const plist = generatePlist({ ...base, port: "5000", env: { APPLE_MCP_PORT: "5000" } });
		expect(plist.match(/APPLE_MCP_PORT/g)).toHaveLength(1);
	});
	test("collectPlistEnv reports an ignored token", () => {
		const r = collectPlistEnv({ APPLE_MCP_TOKEN: "t", APPLE_MCP_PORT: "1", PATH: "/x" });
		expect(r.tokenIgnored).toBe(true);
		expect(r.vars).toEqual({ APPLE_MCP_PORT: "1" });
	});
});

describe("pinned node", () => {
	const noVerify = async (): Promise<void> => {};
	test("plist uses the pinned path; plistNodePath reads it back", () => {
		const plist = generatePlist({ ...base, nodePath: "/u/Library/a&b/runtime/node" });
		expect(plistNodePath(plist)).toBe("/u/Library/a&b/runtime/node");
	});
	test("creates the copy with 0700 dir and 0755 binary", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pin-"));
		const src = join(dir, "src-node");
		writeFileSync(src, "binary-v1");
		const pinned = join(dir, "runtime", "node");
		const res = await pinNode(src, { pinned, verify: noVerify });
		expect(res.action).toBe("created");
		expect(readFileSync(pinned, "utf8")).toBe("binary-v1");
		expect(statSync(join(dir, "runtime")).mode & 0o777).toBe(0o700);
		expect(statSync(pinned).mode & 0o777).toBe(0o755);
	});
	test("does not overwrite an existing pinned copy", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pin-"));
		const src = join(dir, "src-node");
		const pinned = join(dir, "runtime", "node");
		writeFileSync(src, "v1");
		await pinNode(src, { pinned, verify: noVerify });
		writeFileSync(src, "v2");
		const res = await pinNode(src, { pinned, verify: noVerify });
		expect(res.action).toBe("reused");
		expect(readFileSync(pinned, "utf8")).toBe("v1");
	});
	test("replace overwrites; a failed verify keeps the old copy", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pin-"));
		const src = join(dir, "src-node");
		const pinned = join(dir, "runtime", "node");
		writeFileSync(src, "v1");
		await pinNode(src, { pinned, verify: noVerify });
		writeFileSync(src, "v2");
		await expect(
			pinNode(src, {
				pinned,
				replace: true,
				verify: async () => {
					throw new Error("bad copy");
				},
			}),
		).rejects.toThrow("bad copy");
		expect(readFileSync(pinned, "utf8")).toBe("v1");
		expect(existsSync(`${pinned}.new`)).toBe(false);
		const res = await pinNode(src, { pinned, replace: true, verify: noVerify });
		expect(res.action).toBe("replaced");
		expect(readFileSync(pinned, "utf8")).toBe("v2");
	});
});

describe("unknownArgs", () => {
	test("rejects --help and stray words so they never reach install", () => {
		expect(unknownArgs("install", ["--help"])).toEqual(["--help"]);
		expect(unknownArgs("install", ["now"])).toEqual(["now"]);
		expect(unknownArgs("status", ["-h"])).toEqual(["-h"]);
	});
	test("accepts known flags and --node values", () => {
		expect(unknownArgs("install", ["--node", "/usr/local/bin/node"])).toEqual([]);
		expect(unknownArgs("update-node", ["--node", "/x/node", "--yes"])).toEqual([]);
		expect(unknownArgs("doctor", ["--pinned", "--json"])).toEqual([]);
		expect(unknownArgs("uninstall", ["--purge"])).toEqual([]);
		expect(unknownArgs("install", ["--yes"])).toEqual(["--yes"]);
	});
});
