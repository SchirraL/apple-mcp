import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { OsaError } from "./applescript.js";
import { PathPolicyError } from "./paths.js";

export type { CallToolResult };

/** One app's set of tools. Registered in src/registry.ts. */
export interface ToolModule {
	tools: Tool[];
	handle(name: string, args: unknown): Promise<CallToolResult>;
}

export interface ToolDef<S extends z.ZodTypeAny> {
	name: string;
	description: string;
	schema: S;
	run(args: z.infer<S>): Promise<CallToolResult>;
}

export function defineTool<S extends z.ZodTypeAny>(def: ToolDef<S>): ToolDef<S> {
	return def;
}

/** Build a ToolModule from tool definitions: JSON schemas, validation and error mapping. */
export function toolModule(defs: ToolDef<any>[]): ToolModule {
	const byName = new Map(defs.map((d) => [d.name, d]));
	return {
		tools: defs.map((d) => {
			const { $schema, ...inputSchema } = zodToJsonSchema(d.schema, {
				$refStrategy: "none",
			}) as Record<string, unknown>;
			return { name: d.name, description: d.description, inputSchema } as Tool;
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
			try {
				return await def.run(parsed.data);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				const expected = error instanceof OsaError || error instanceof PathPolicyError;
				if (!expected) console.error(`[${name}]`, error);
				return errorResult(msg);
			}
		},
	};
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
