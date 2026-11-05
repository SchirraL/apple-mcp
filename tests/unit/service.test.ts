import { describe, expect, test } from "bun:test";
import {
	claudeCodeCommand,
	desktopConfig,
	generatePlist,
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
