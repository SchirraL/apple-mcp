import { describe, expect, test } from "bun:test";
import { generateInfoPlist, unknownArgs } from "../../scripts/menubar.js";

describe("generateInfoPlist", () => {
	const plist = generateInfoPlist("1.2.0");
	test("has the identity keys", () => {
		expect(plist).toContain("<string>io.schirra.apple-mcp.menubar</string>");
		expect(plist).toContain("<key>CFBundleExecutable</key>");
		expect(plist).toContain("<key>CFBundleName</key>\n\t<string>Apple MCP</string>");
	});
	test("is an agent app with minimum macOS 14", () => {
		expect(plist).toContain("<key>LSUIElement</key>\n\t<true/>");
		expect(plist).toContain("<key>LSMinimumSystemVersion</key>\n\t<string>14.0</string>");
	});
	test("uses the given version and escapes it", () => {
		expect(plist).toContain("<key>CFBundleShortVersionString</key>\n\t<string>1.2.0</string>");
		expect(generateInfoPlist("1<2")).toContain("1&lt;2");
	});
});

describe("unknownArgs", () => {
	test("rejects everything", () => {
		expect(unknownArgs("build", [])).toEqual([]);
		expect(unknownArgs("install", ["--help"])).toEqual(["--help"]);
	});
});
