import { z } from "zod";
import { readAudit } from "../../lib/audit.js";
import { type ToolModule, dataResult, defineTool, toolModule } from "../../lib/types.js";

export function createAuditModule(): ToolModule {
	return toolModule([
		defineTool({
			name: "get_audit_log",
			effect: "read",
			description:
				"Show the most recent entries of apple-mcp's own audit log: every state-changing or " +
				"outward-facing tool call (and previews) with time, tool, mode (confirmed / " +
				"previewed / direct), outcome and a privacy-safe target. Message and note content " +
				"is never logged, only lengths. Newest first.",
			schema: z.object({
				limit: z.number().int().min(1).max(500).default(50).describe("Max entries (default 50)"),
				tool: z.string().min(1).optional().describe("Only this exact tool name"),
				since: z.string().min(1).optional().describe("Only entries at/after this ISO timestamp"),
			}),
			async run({ limit, tool, since }) {
				if (since !== undefined && Number.isNaN(Date.parse(since))) {
					throw new Error(`Invalid 'since' timestamp: ${since}`);
				}
				const entries = readAudit({ limit, tool, since });
				return dataResult(`${entries.length} audit log entries (newest first).`, entries);
			},
		}),
	]);
}
