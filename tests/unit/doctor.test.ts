import { describe, expect, test } from "bun:test";
import type { DoctorBridge, FileProbe, PrivacyStatuses } from "../../src/tools/doctor/bridge.js";
import {
	createDoctorModule,
	formatReport,
	mapAutomationCode,
	mapContactsStatus,
	mapEventKitStatus,
	mapFileProbe,
	runDoctor,
} from "../../src/tools/doctor/handler.js";

const HOST = "/host/node";

function fakeBridge(over: Partial<DoctorBridge> = {}): DoctorBridge {
	const privacy: PrivacyStatuses = {
		events: 3,
		reminders: 3,
		contacts: 3,
		eventCalendars: 4,
		reminderLists: 2,
	};
	return {
		host: () => ({ binary: HOST, pid: 1 }),
		privacyStatuses: async () => privacy,
		automation: async (ids) => Object.fromEntries(ids.map((i) => [i, { code: 0, ms: 1 }])),
		probeChatDb: async () => ({ result: "ok" }),
		probeMailIndex: async () => ({ result: "ok" }),
		...over,
	};
}

describe("status mapping", () => {
	test("automation codes", () => {
		expect(mapAutomationCode(0, "Notes", HOST).status).toBe("ok");
		const denied = mapAutomationCode(-1743, "Notes", HOST);
		expect(denied.status).toBe("denied");
		expect(denied.fix).toBe(
			`System Settings → Privacy & Security → Automation → ${HOST} → enable Notes`,
		);
		expect(mapAutomationCode(-1744, "Notes", HOST).status).toBe("not_determined");
		const nr = mapAutomationCode(-600, "Music", HOST);
		expect(nr.status).toBe("not_running");
		expect(nr.detail).toContain("without launching");
		expect(nr.fix).toBeUndefined();
		expect(mapAutomationCode(-1, "Mail", HOST).status).toBe("unknown");
	});
	test("eventkit statuses", () => {
		expect(mapEventKitStatus(3, "Calendars", HOST, 4).status).toBe("ok");
		expect(mapEventKitStatus(0, "Calendars", HOST, null).status).toBe("not_determined");
		expect(mapEventKitStatus(1, "Calendars", HOST, null).status).toBe("restricted");
		const d = mapEventKitStatus(2, "Reminders", HOST, null);
		expect(d.status).toBe("denied");
		expect(d.fix).toBe(`System Settings → Privacy & Security → Reminders → enable ${HOST}`);
		expect(mapEventKitStatus(4, "Calendars", HOST, null).status).toBe("denied");
		expect(mapEventKitStatus(9, "Calendars", HOST, null).status).toBe("unknown");
	});
	test("contacts statuses incl. limited", () => {
		expect(mapContactsStatus(3, HOST).status).toBe("ok");
		expect(mapContactsStatus(4, HOST).detail).toContain("limited");
		expect(mapContactsStatus(2, HOST).fix).toContain("Contacts");
	});
	test("file probe: ENOENT is not an error, EPERM is denied", () => {
		const missing: FileProbe = { result: "missing", detail: "ENOENT" };
		expect(mapFileProbe(missing, "chat.db", HOST).status).toBe("not_present");
		const denied = mapFileProbe({ result: "denied", detail: "EPERM" }, "chat.db", HOST);
		expect(denied.status).toBe("denied");
		expect(denied.fix).toBe(`System Settings → Privacy & Security → Full Disk Access → enable ${HOST}`);
		expect(mapFileProbe({ result: "error", detail: "boom" }, "x", HOST).status).toBe("error");
	});
});

describe("runDoctor", () => {
	test("reports host binary and every check", async () => {
		const report = await runDoctor(fakeBridge());
		expect(report.host.binary).toBe(HOST);
		expect(report.checks.map((c) => c.id)).toContain("automation_finder");
		expect(report.checks.every((c) => c.status === "ok")).toBe(true);
		expect(formatReport(report)).toContain(HOST);
	});
	test("a failing bridge call becomes an error check, others survive", async () => {
		const report = await runDoctor(
			fakeBridge({
				privacyStatuses: async () => {
					throw new Error("timed out");
				},
				probeChatDb: async () => ({ result: "denied", detail: "EPERM" }),
			}),
		);
		const by = Object.fromEntries(report.checks.map((c) => [c.id, c]));
		expect(by.calendars?.status).toBe("error");
		expect(by.contacts?.detail).toBe("timed out");
		expect(by.fda_messages?.status).toBe("denied");
		expect(by.automation_notes?.status).toBe("ok");
	});
});

describe("apple_mcp_doctor tool", () => {
	test("is read-only, takes no arguments, never fails on denial", async () => {
		const mod = createDoctorModule(
			fakeBridge({ automation: async () => ({ "com.apple.Notes": { code: -1743, ms: 1 } }) }),
		);
		expect(mod.tools).toHaveLength(1);
		const tool = mod.tools[0] as { name: string; inputSchema: { properties?: object } };
		expect(tool.name).toBe("apple_mcp_doctor");
		expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual([]);
		const res = await mod.handle("apple_mcp_doctor", {});
		expect(res.isError).toBeFalsy();
		const text = (res.content[0] as { text: string }).text;
		expect(text).toContain("1 permission(s) denied");
		expect(text).toContain("enable Notes");
	});
});
