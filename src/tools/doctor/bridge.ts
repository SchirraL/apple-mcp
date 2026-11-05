import { closeSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runJxa } from "../../lib/applescript.js";

// Read-only permission probes. HARD RULE: nothing here may trigger a macOS permission prompt
// or launch an app — no requestAccess*, no `tell application`, and Apple Event permission is
// queried with askUserIfNeeded = false.

export interface HostInfo {
	/** realpath of process.execPath: the binary macOS permissions are granted to. */
	binary: string;
	pid: number;
}

export interface PrivacyStatuses {
	/** Raw authorizationStatus values (EventKit 0-4, Contacts 0-4). */
	events: number;
	reminders: number;
	contacts: number;
	/** Calendar counts, only when full access is granted (else null). */
	eventCalendars: number | null;
	reminderLists: number | null;
}

export interface AutomationResult {
	/** OSStatus from AEDeterminePermissionToAutomateTarget. */
	code: number;
	ms: number;
}

export type FileProbe =
	| { result: "ok" }
	| { result: "denied"; detail: string }
	| { result: "missing"; detail: string }
	| { result: "error"; detail: string };

export interface DoctorBridge {
	host(): HostInfo;
	privacyStatuses(): Promise<PrivacyStatuses>;
	automation(bundleIds: string[]): Promise<Record<string, AutomationResult>>;
	probeChatDb(): Promise<FileProbe>;
	probeMailIndex(): Promise<FileProbe>;
}

const JXA_TIMEOUT_MS = 10_000;

// JXA bodies are serialised with toString(): self-contained, loosely typed.
function privacyStatusesJxa(): PrivacyStatuses {
	ObjC.import("EventKit");
	ObjC.import("Contacts");
	// authorizationStatusForEntityType never prompts. Values arrive as numbers/strings.
	const status = (t: any): number => Number($.EKEventStore.authorizationStatusForEntityType(t));
	const events = status($.EKEntityTypeEvent);
	const reminders = status($.EKEntityTypeReminder);
	const contacts = Number(
		$.CNContactStore.authorizationStatusForEntityType($.CNEntityTypeContacts),
	);
	// Counting calendars needs no prompt once access is already full (3).
	const count = (st: number, t: any): number | null => {
		if (st !== 3) return null;
		return Number($.EKEventStore.alloc.init.calendarsForEntityType(t).count);
	};
	return {
		events,
		reminders,
		contacts,
		eventCalendars: count(events, $.EKEntityTypeEvent),
		reminderLists: count(reminders, $.EKEntityTypeReminder),
	};
}

function automationJxa(bundleIds: string[]): Record<string, AutomationResult> {
	ObjC.import("Foundation");
	ObjC.import("CoreServices");
	// The generated binding rejects the AEDesc pointer; rebind with an opaque pointer type.
	ObjC.bindFunction("AEDeterminePermissionToAutomateTarget", ["i", ["^v", "I", "I", "B"]]);
	const out: Record<string, AutomationResult> = {};
	for (const id of bundleIds) {
		const start = Date.now();
		const desc = $.NSAppleEventDescriptor.descriptorWithBundleIdentifier(id);
		// typeWildCard ('****') for class and id; askUserIfNeeded = false (never prompts).
		const code = Number(
			($ as any).AEDeterminePermissionToAutomateTarget(
				desc.aeDesc,
				0x2a2a2a2a,
				0x2a2a2a2a,
				false,
			),
		);
		out[id] = { code, ms: Date.now() - start };
	}
	return out;
}

function classify(error: unknown): FileProbe {
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "ENOENT" || code === "ENOTDIR") return { result: "missing", detail: code };
	if (code === "EPERM" || code === "EACCES") return { result: "denied", detail: code };
	return { result: "error", detail: String((error as Error).message) };
}

/** Read the first bytes (SQLite header) of a file; classify the failure, never the content. */
function probeFile(path: string): FileProbe {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		readSync(fd, Buffer.alloc(16), 0, 16, 0);
		return { result: "ok" };
	} catch (error) {
		return classify(error);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function mailIndexPath(): { path: string } | FileProbe {
	const root = join(homedir(), "Library/Mail");
	try {
		const versions = readdirSync(root)
			.map((d) => /^V(\d+)$/.exec(d)?.[1])
			.filter((v): v is string => v !== undefined)
			.map(Number);
		if (versions.length === 0) return { result: "missing", detail: "no Mail data directory" };
		return { path: join(root, `V${Math.max(...versions)}`, "MailData/Envelope Index") };
	} catch (error) {
		return classify(error);
	}
}

export const doctorBridge: DoctorBridge = {
	host(): HostInfo {
		let binary = process.execPath;
		try {
			binary = realpathSync(process.execPath);
		} catch {
			// keep execPath
		}
		return { binary, pid: process.pid };
	},
	privacyStatuses: () => runJxa(privacyStatusesJxa, null, { timeoutMs: JXA_TIMEOUT_MS }),
	automation: (bundleIds) => runJxa(automationJxa, bundleIds, { timeoutMs: JXA_TIMEOUT_MS }),
	probeChatDb: async () => probeFile(join(homedir(), "Library/Messages/chat.db")),
	async probeMailIndex(): Promise<FileProbe> {
		const found = mailIndexPath();
		return "path" in found ? probeFile(found.path) : found;
	},
};
