import { z } from "zod";
import { type CallToolResult, textResult } from "./types.js";

/** Schema field for destructive / outward-facing tools. */
export const confirmField = z
	.boolean()
	.optional()
	.describe(
		"Must be true to actually perform this action. Omit it first to get a preview, " +
			"show the preview to the user, and only then call again with confirm: true.",
	);

/**
 * Gate a destructive action: without confirm, return a preview and do nothing.
 */
export async function withConfirm(
	confirm: boolean | undefined,
	preview: () => string | Promise<string>,
	perform: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
	if (confirm !== true) {
		return textResult(
			`PREVIEW — nothing was changed.\n${await preview()}\n\n` +
				"Call again with confirm: true to proceed.",
		);
	}
	return perform();
}
