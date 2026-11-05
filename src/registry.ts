import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, ToolModule } from "./lib/types.js";
import { createCalendarModule } from "./tools/calendar/handler.js";
import { createContactsModule } from "./tools/contacts/handler.js";
import { createMailModule } from "./tools/mail/handler.js";
import { createMapsModule } from "./tools/maps/handler.js";
import { createMessagesModule } from "./tools/messages/handler.js";
import { createNotesModule } from "./tools/notes/handler.js";
import { createRemindersModule } from "./tools/reminders/handler.js";

/** Migrated apps. Add a module here — nothing else needs editing. */
const modules: ToolModule[] = [
	createRemindersModule(),
	createCalendarModule(),
	createNotesModule(),
	createMessagesModule(),
	createContactsModule(),
	createMapsModule(),
	createMailModule(),
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
