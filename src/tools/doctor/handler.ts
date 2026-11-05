import { z } from "zod";
import { dataResult, defineTool, type ToolModule, toolModule } from "../../lib/types.js";
import {
	type DoctorBridge,
	doctorBridge,
	type FileProbe,
	type PrivacyStatuses,
} from "./bridge.js";

export type CheckStatus =
	| "ok"
	| "denied"
	| "not_determined"
	| "restricted"
	| "unknown"
	| "error"
	| "not_present"
	| "not_running";

export interface Check {
	id: string;
	label: string;
	status: CheckStatus;
	detail: string;
	/** The exact setting to change, when status is not ok. */
	fix?: string;
	ms: number;
}

export interface DoctorReport {
	host: { binary: string; pid: number; note: string };
	checks: Check[];
	totalMs: number;
}

const SETTINGS = "System Settings → Privacy & Security";

export const AUTOMATION_TARGETS: { id: string; app: string; bundle: string }[] = [
	{ id: "automation_notes", app: "Notes", bundle: "com.apple.Notes" },
	{ id: "automation_messages", app: "Messages", bundle: "com.apple.MobileSMS" },
	{ id: "automation_mail", app: "Mail", bundle: "com.apple.mail" },
	{ id: "automation_music", app: "Music", bundle: "com.apple.Music" },
	{ id: "automation_finder", app: "Finder", bundle: "com.apple.finder" },
	{ id: "automation_contacts", app: "Contacts", bundle: "com.apple.AddressBook" },
];

const grantFix = (pane: string, host: string): string =>
	`${SETTINGS} → ${pane} → enable ${host}`;

/**
 * Calendars, Reminders, Contacts and Automation have no "+" in System Settings: a binary is
 * only listed after it has asked. The doctor never asks, so tell the user how to trigger it.
 */
function askFirst(tool: string): string {
	return (
		`not listed in System Settings until asked: call ${tool} once through the service and ` +
		"click Allow on the macOS prompt (the call may time out while the prompt is open; " +
		"call it again)"
	);
}

type Mapped = Pick<Check, "status" | "detail" | "fix">;

/** EventKit status (macOS 14+): 0 notDetermined, 1 restricted, 2 denied, 3 full, 4 write-only. */
export function mapEventKitStatus(
	value: number,
	pane: "Calendars" | "Reminders",
	host: string,
	count: number | null,
): Mapped {
	const fix = grantFix(pane, host);
	switch (value) {
		case 3:
			return {
				status: "ok",
				detail: `full access${count === null ? "" : `, ${count} calendars/lists visible`}`,
			};
		case 4:
			return {
				status: "denied",
				detail: "write-only access; reading needs Full Access",
				fix: `${fix} (set to Full Access)`,
			};
		case 2:
			return { status: "denied", detail: "access denied", fix };
		case 1:
			return {
				status: "restricted",
				detail: "restricted by a profile or parental controls; cannot be changed here",
			};
		case 0:
			return {
				status: "not_determined",
				detail: "never asked for this host; the doctor does not prompt",
				fix: askFirst(pane === "Calendars" ? "list_calendars" : "list_reminder_lists"),
			};
		default:
			return { status: "unknown", detail: `unexpected authorization status ${value}` };
	}
}

/** Contacts status: 0 notDetermined, 1 restricted, 2 denied, 3 authorized, 4 limited. */
export function mapContactsStatus(value: number, host: string): Mapped {
	const fix = grantFix("Contacts", host);
	switch (value) {
		case 3:
			return { status: "ok", detail: "authorized" };
		case 4:
			return { status: "ok", detail: "limited access (only selected contacts are visible)" };
		case 2:
			return { status: "denied", detail: "access denied", fix };
		case 1:
			return {
				status: "restricted",
				detail: "restricted by a profile or parental controls; cannot be changed here",
			};
		case 0:
			return {
				status: "not_determined",
				detail: "never asked for this host; the doctor does not prompt",
				fix: askFirst("list_contacts"),
			};
		default:
			return { status: "unknown", detail: `unexpected authorization status ${value}` };
	}
}

/** AEDeterminePermissionToAutomateTarget result codes. */
export function mapAutomationCode(code: number, app: string, host: string): Mapped {
	const fix = `${SETTINGS} → Automation → ${host} → enable ${app}`;
	switch (code) {
		case 0:
			return { status: "ok", detail: "allowed" };
		case -1743:
			return { status: "denied", detail: "not allowed (errAEEventNotPermitted)", fix };
		case -1744:
			return {
				status: "not_determined",
				detail: "would require user consent; the doctor does not prompt",
				fix: askFirst(`a ${app} tool that controls the app`),
			};
		case -600:
			return {
				status: "not_running",
				detail: `${app} is not running; can't check without launching it`,
			};
		default:
			return {
				status: "unknown",
				detail: `unexpected status ${code}`,
				fix: `${SETTINGS} → Automation → ${host} → check ${app}`,
			};
	}
}

export function mapFileProbe(probe: FileProbe, what: string, host: string): Mapped {
	switch (probe.result) {
		case "ok":
			return { status: "ok", detail: `${what} readable` };
		case "missing":
			return { status: "not_present", detail: `${what} not present (${probe.detail})` };
		case "denied":
			return {
				status: "denied",
				detail: `${what} blocked (${probe.detail})`,
				fix: grantFix("Full Disk Access", host),
			};
		default:
			return { status: "error", detail: `${what}: ${probe.detail}` };
	}
}

async function timed(id: string, label: string, fn: () => Promise<Mapped>): Promise<Check> {
	const start = Date.now();
	try {
		return { id, label, ...(await fn()), ms: Date.now() - start };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { id, label, status: "error", detail, ms: Date.now() - start };
	}
}

/** Run every check. Read-only: never prompts and never launches an app. */
export async function runDoctor(bridge: DoctorBridge = doctorBridge): Promise<DoctorReport> {
	const start = Date.now();
	const hostInfo = bridge.host();
	const host = hostInfo.binary;

	// One JXA call serves calendars, reminders and contacts; one serves all Automation targets.
	const privacy = bridge.privacyStatuses();
	const automation = bridge.automation(AUTOMATION_TARGETS.map((t) => t.bundle));
	privacy.catch(() => undefined);
	automation.catch(() => undefined);

	const fromPrivacy = (
		id: string,
		label: string,
		f: (p: PrivacyStatuses) => Mapped,
	): Promise<Check> => timed(id, label, async () => f(await privacy));

	const checks = await Promise.all([
		fromPrivacy("calendars", "Calendars", (p) =>
			mapEventKitStatus(p.events, "Calendars", host, p.eventCalendars),
		),
		fromPrivacy("reminders", "Reminders", (p) =>
			mapEventKitStatus(p.reminders, "Reminders", host, p.reminderLists),
		),
		fromPrivacy("contacts", "Contacts", (p) => mapContactsStatus(p.contacts, host)),
		timed("fda_messages", "Full Disk Access: Messages", async () =>
			mapFileProbe(await bridge.probeChatDb(), "~/Library/Messages/chat.db", host),
		),
		timed("fda_mail", "Full Disk Access: Mail", async () =>
			mapFileProbe(await bridge.probeMailIndex(), "Mail Envelope Index", host),
		),
		...AUTOMATION_TARGETS.map((t) =>
			timed(t.id, `Automation: ${t.app}`, async (): Promise<Mapped> => {
				const r = (await automation)[t.bundle];
				if (!r) return { status: "unknown", detail: "no result for target" };
				return mapAutomationCode(r.code, t.app, host);
			}),
		),
	]);

	return {
		host: {
			binary: host,
			pid: hostInfo.pid,
			note:
				"macOS privacy permissions belong to this binary (or, when started from an app " +
				"such as Terminal, to that app as the responsible process).",
		},
		checks,
		totalMs: Date.now() - start,
	};
}

/** Plain-text table for the CLI. */
export function formatReport(report: DoctorReport): string {
	const lines = [
		`Permissions checked for: ${report.host.binary} (pid ${report.host.pid})`,
		report.host.note,
		"",
	];
	const w = Math.max(...report.checks.map((c) => c.label.length));
	const sw = Math.max(...report.checks.map((c) => c.status.length));
	for (const c of report.checks) {
		lines.push(
			`${c.label.padEnd(w)}  ${c.status.padEnd(sw)}  ${String(c.ms).padStart(5)}ms  ${c.detail}`,
		);
		if (c.fix) lines.push(`${" ".repeat(w + 2)}-> ${c.fix}`);
	}
	lines.push("", `Total ${report.totalMs}ms`);
	return lines.join("\n");
}

export function createDoctorModule(bridge: DoctorBridge = doctorBridge): ToolModule {
	return toolModule([
		defineTool({
			name: "apple_mcp_doctor",
			description:
				"Diagnose macOS privacy permissions for this server (Calendars, Reminders, Contacts, " +
				"Full Disk Access for Messages/Mail, Automation for Notes/Messages/Mail/Music/" +
				"Finder/Contacts). Read-only: never prompts or launches apps. Returns per-check " +
				"status, the host binary permissions belong to, and the exact System Settings " +
				"change needed when something is not ok. Use when a tool fails with a permission " +
				"error.",
			effect: "read",
			schema: z.object({}),
			async run() {
				const report = await runDoctor(bridge);
				const bad = report.checks.filter((c) => c.status === "denied").length;
				const summary = bad
					? `${bad} permission(s) denied for ${report.host.binary}.`
					: `No denied permissions for ${report.host.binary}.`;
				return dataResult(summary, report);
			},
		}),
	]);
}
