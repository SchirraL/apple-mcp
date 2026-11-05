import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, ToolModule } from "./lib/types.js";
import { createAuditModule } from "./tools/audit/handler.js";
import { createCalendarModule } from "./tools/calendar/handler.js";
import { createDoctorModule } from "./tools/doctor/handler.js";
import { createContactsModule } from "./tools/contacts/handler.js";
import { createFilesModule } from "./tools/files/handler.js";
import { createFinderModule } from "./tools/finder/handler.js";
import { createMailModule } from "./tools/mail/handler.js";
import { createMapsModule } from "./tools/maps/handler.js";
import { createMessagesModule } from "./tools/messages/handler.js";
import { createMusicModule } from "./tools/music/handler.js";
import { createNotesModule } from "./tools/notes/handler.js";
import { createObsidianModule } from "./tools/obsidian/handler.js";
import { createPdfModule } from "./tools/pdf/handler.js";
import { createRemindersModule } from "./tools/reminders/handler.js";
import { createShortcutsModule } from "./tools/shortcuts/handler.js";

interface AppEntry {
	/** Tool directory name; also the value accepted in APPLE_MCP_APPS. */
	name: string;
	create: () => ToolModule;
}

/**
 * Toggleable apps. Add an app here — nothing else needs editing. Enabled apps are chosen by
 * APPLE_MCP_APPS (comma-separated names; unset means all). Keep this list in registry order.
 */
const apps: AppEntry[] = [
	{ name: "reminders", create: createRemindersModule },
	{ name: "calendar", create: createCalendarModule },
	{ name: "notes", create: createNotesModule },
	{ name: "messages", create: createMessagesModule },
	{ name: "contacts", create: createContactsModule },
	{ name: "maps", create: createMapsModule },
	{ name: "mail", create: createMailModule },
	{ name: "pdf", create: createPdfModule },
	{ name: "files", create: createFilesModule },
	{ name: "finder", create: createFinderModule },
	{ name: "shortcuts", create: createShortcutsModule },
	{ name: "music", create: createMusicModule },
	{ name: "obsidian", create: createObsidianModule },
];

/**
 * Modules that are always registered and cannot be disabled via APPLE_MCP_APPS:
 * the server's own diagnostics and audit trail, not an app.
 */
const alwaysOn: ToolModule[] = [createDoctorModule(), createAuditModule()];

/**
 * Pure: resolves APPLE_MCP_APPS to the list of enabled app names, in registry order.
 * Unset, empty or whitespace-only means all apps. Throws on unknown names.
 */
export function selectApps(env: NodeJS.ProcessEnv = process.env): string[] {
	const valid = apps.map((a) => a.name);
	const raw = (env.APPLE_MCP_APPS ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter((s) => s.length > 0);
	if (raw.length === 0) return valid;

	const requested = new Set(raw);
	const unknown = [...requested].filter((n) => !valid.includes(n));
	if (unknown.length > 0) {
		throw new Error(
			`Unknown app(s) in APPLE_MCP_APPS: ${unknown.join(", ")}. Valid: ${valid.join(", ")}`,
		);
	}
	return valid.filter((n) => requested.has(n));
}

/** Names of the apps enabled for this process. Throws at startup on a bad APPLE_MCP_APPS. */
export const enabledApps: string[] = selectApps();

const enabled = new Set(enabledApps);
const modules: ToolModule[] = [
	...alwaysOn,
	...apps.filter((a) => enabled.has(a.name)).map((a) => a.create()),
];

const owner = new Map<string, ToolModule>();
for (const m of modules) {
	for (const t of m.tools) {
		if (owner.has(t.name)) throw new Error(`Duplicate tool name: ${t.name}`);
		owner.set(t.name, m);
	}
}

export const registeredTools: Tool[] = modules.flatMap((m) => m.tools);

export function hasTool(name: string): boolean {
	return owner.has(name);
}

export function callTool(name: string, args: unknown): Promise<CallToolResult> {
	const m = owner.get(name);
	if (!m) throw new Error(`Unknown tool: ${name}`);
	return m.handle(name, args);
}
