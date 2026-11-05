import type { Tool, ToolAnnotations, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { OsaError } from "./applescript.js";
import { type Effect, appendAudit, sanitizeTarget, summarizeArgs } from "./audit.js";
import { PathPolicyError } from "./paths.js";

export type { CallToolResult, Effect };

/** One app's set of tools. Registered in src/registry.ts. */
export interface ToolModule {
	tools: Tool[];
	handle(name: string, args: unknown): Promise<CallToolResult>;
}

export interface ToolDef<S extends z.ZodTypeAny> {
	name: string;
	description: string;
	schema: S;
	/**
	 * read = no side effects; write = changes local state (incl. opening UI);
	 * external = reaches other people or runs arbitrary automation (send, run_shortcut).
	 */
	effect: Effect;
	/** Tool reaches the network although it only reads (e.g. geocoding). */
	openWorld?: boolean;
	/** Override the audit-log target summary where the generic allowlist is wrong. */
	auditTarget?: (args: z.infer<S>) => Record<string, unknown>;
	run(args: z.infer<S>): Promise<CallToolResult>;
}

export function defineTool<S extends z.ZodTypeAny>(def: ToolDef<S>): ToolDef<S> {
	return def;
}

/** Build a ToolModule from tool definitions: JSON schemas, validation and error mapping. */
export function toolModule(defs: ToolDef<any>[]): ToolModule {
	const byName = new Map(defs.map((d) => [d.name, d]));
	const gatedByName = new Map<string, boolean>();
	return {
		tools: defs.map((d) => {
			const { $schema, ...inputSchema } = zodToJsonSchema(d.schema, {
				$refStrategy: "none",
			}) as Record<string, unknown>;
			const props = (inputSchema.properties ?? {}) as Record<string, unknown>;
			gatedByName.set(d.name, "confirm" in props);
			return {
				name: d.name,
				description: d.description,
				inputSchema,
				annotations: annotationsFor(d, "confirm" in props),
			} as Tool;
		}),
		async handle(name: string, args: unknown): Promise<CallToolResult> {
			const def = byName.get(name);
			if (!def) return errorResult(`Unknown tool: ${name}`);
			const parsed = def.schema.safeParse(args ?? {});
			if (!parsed.success) {
				const issues = parsed.error.issues
					.map((i: z.ZodIssue) => `${i.path.join(".") || "(root)"}: ${i.message}`)
					.join("; ");
				return errorResult(`Invalid arguments for ${name}: ${issues}`);
			}
			const started = Date.now();
			let result: CallToolResult;
			let error: string | undefined;
			try {
				result = await def.run(parsed.data);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				const expected = e instanceof OsaError || e instanceof PathPolicyError;
				if (!expected) console.error(`[${name}]`, e);
				result = errorResult(msg);
				error = msg;
			}
			if (def.effect !== "read") {
				audit(def, gatedByName.get(name) === true, parsed.data, result, error, Date.now() - started);
			}
			return result;
		},
	};
}

function annotationsFor(d: ToolDef<any>, gated: boolean): ToolAnnotations {
	if (d.effect === "read") {
		return { readOnlyHint: true, openWorldHint: d.openWorld === true };
	}
	if (d.effect === "external") {
		return { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
	}
	return { readOnlyHint: false, destructiveHint: gated, openWorldHint: false };
}

function audit(
	d: ToolDef<any>,
	gated: boolean,
	args: Record<string, unknown>,
	result: CallToolResult,
	error: string | undefined,
	ms: number,
): void {
	try {
		const first = result.content?.[0];
		const previewed = first?.type === "text" && first.text.startsWith("PREVIEW");
		const mode = args?.confirm === true ? "confirmed" : gated && previewed ? "previewed" : "direct";
		const target = d.auditTarget ? sanitizeTarget(d.auditTarget(args)) : summarizeArgs(args);
		appendAudit({
			ts: new Date().toISOString(),
			tool: d.name,
			effect: d.effect,
			mode,
			outcome: error === undefined && !result.isError ? "ok" : "error",
			...(error !== undefined || result.isError
				? { error: redactArgs(error ?? textOf(result), args) }
				: {}),
			target,
			ms,
		});
	} catch (e) {
		console.error("[audit] failed:", e);
	}
}

/**
 * Error texts often echo user input ("No note named …"). Replace every string argument value
 * (3+ chars, any nesting) that appears in the message, so the audit log never holds content.
 */
export function redactArgs(message: string, args: unknown): string {
	const values: string[] = [];
	const collect = (v: unknown): void => {
		if (typeof v === "string") {
			const s = v.trim();
			if (s.length >= 3) values.push(s);
		} else if (Array.isArray(v)) v.forEach(collect);
		else if (typeof v === "object" && v !== null) Object.values(v).forEach(collect);
	};
	collect(args);
	let out = message;
	// Longest first, so a value containing a shorter one is redacted whole.
	for (const s of values.sort((a, b) => b.length - a.length)) {
		out = out.split(s).join("[redacted]");
	}
	return out;
}

function textOf(r: CallToolResult): string {
	const first = r.content?.[0];
	return first?.type === "text" ? first.text : "error";
}

export function textResult(text: string): CallToolResult {
	return { content: [{ type: "text", text }] };
}

/** Human summary line followed by pretty JSON data — readable for both LLM and user. */
export function dataResult(summary: string, data: unknown): CallToolResult {
	return textResult(`${summary}\n\n${JSON.stringify(data, null, 2)}`);
}

export function errorResult(text: string): CallToolResult {
	return { content: [{ type: "text", text }], isError: true };
}
