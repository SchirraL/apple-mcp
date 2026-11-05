import { describe, expect, test } from "bun:test";
import {
	parseClientApps,
	registeredTools,
	selectApps,
	toolAllowed,
	toolsFor,
} from "../../src/registry.ts";

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

describe("per-client app subsets", () => {
	test("parseClientApps normalises, dedupes, and empty means all", () => {
		expect(parseClientApps(" Reminders, calendar,reminders ")).toEqual(["reminders", "calendar"]);
		expect(parseClientApps("")).toBeUndefined();
		expect(parseClientApps(" , ")).toBeUndefined();
	});
	test("parseClientApps rejects unknown names and lists the valid ones", () => {
		expect(() => parseClientApps("reminders,nope")).toThrow(/Unknown app\(s\): nope\. Valid: /);
	});
	test("toolsFor limits the list but keeps the always-on tools", () => {
		const names = toolsFor(["reminders"]).map((t) => t.name);
		expect(names).toContain("list_reminders");
		expect(names).toContain("apple_mcp_doctor");
		expect(names).toContain("get_audit_log");
		expect(names).not.toContain("list_calendars");
		expect(names).not.toContain("send_email");
		expect(toolsFor(undefined)).toBe(registeredTools);
	});
	test("toolAllowed gates calls the same way as the list", () => {
		expect(toolAllowed("send_email", ["reminders"])).toBe(false);
		expect(toolAllowed("send_email", undefined)).toBe(true);
		expect(toolAllowed("get_audit_log", ["notes"])).toBe(true);
		expect(toolAllowed("no_such_tool", undefined)).toBe(false);
	});
});
