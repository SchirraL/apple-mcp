import { describe, expect, test } from "bun:test";
import { selectApps } from "../../src/registry.ts";

const ALL = [
	"reminders",
	"calendar",
	"notes",
	"messages",
	"contacts",
	"maps",
	"mail",
	"pdf",
	"files",
	"finder",
	"shortcuts",
	"music",
	"obsidian",
];

describe("selectApps", () => {
	test("unset enables all 13 apps in registry order", () => {
		expect(selectApps({})).toEqual(ALL);
		expect(selectApps({}).length).toBe(13);
	});

	test("comma list is trimmed and case-insensitive", () => {
		expect(selectApps({ APPLE_MCP_APPS: "reminders, Calendar" })).toEqual([
			"reminders",
			"calendar",
		]);
	});

	test("duplicates and empty items are ignored", () => {
		expect(selectApps({ APPLE_MCP_APPS: " mail,,MAIL ,pdf, " })).toEqual(["mail", "pdf"]);
	});

	test("unknown names throw and list the valid names", () => {
		expect(() => selectApps({ APPLE_MCP_APPS: "foo" })).toThrow(
			`Unknown app(s) in APPLE_MCP_APPS: foo. Valid: ${ALL.join(", ")}`,
		);
		expect(() => selectApps({ APPLE_MCP_APPS: "mail, x, y" })).toThrow(
			"Unknown app(s) in APPLE_MCP_APPS: x, y.",
		);
	});

	test("empty and whitespace-only values enable all apps", () => {
		expect(selectApps({ APPLE_MCP_APPS: "" })).toEqual(ALL);
		expect(selectApps({ APPLE_MCP_APPS: "   " })).toEqual(ALL);
	});
});
