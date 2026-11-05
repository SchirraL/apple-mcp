import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

// Shared file-access policy for every tool that takes a path (files, finder, pdf, ...).
// A tool that reads/writes files has the reach of the process running it, so:
//   - paths must resolve (symlinks included) inside an allowed root (default: home dir)
//   - well-known secret stores are always denied
// Configure with APPLE_MCP_FILE_ROOTS / APPLE_MCP_FILE_DENY (colon-separated paths).

export type AccessMode = "read" | "write";

const HOME = homedir();

/** Always denied, for read and write. Relative entries are relative to $HOME. */
const DEFAULT_DENY = [
	".ssh",
	".gnupg",
	".aws",
	".azure",
	".kube",
	".docker",
	".netrc",
	".npmrc",
	".pypirc",
	".config/gh",
	".config/gcloud",
	"Library/Keychains",
	"Library/Cookies",
	"Library/Messages", // read through the messages tools, never as raw files
	"Library/Mail",
	"Library/Application Support/com.apple.TCC",
	"Library/Group Containers/group.com.apple.notes",
	"Library/Accounts",
];

export class PathPolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PathPolicyError";
	}
}

function splitEnv(value: string | undefined): string[] {
	return (value ?? "")
		.split(":")
		.map((s) => s.trim())
		.filter(Boolean);
}

function canonical(p: string): string {
	// realpath the longest existing prefix so symlinked parents can't escape a root.
	let existing = p;
	const rest: string[] = [];
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) break;
		rest.unshift(basename(existing));
		existing = parent;
	}
	let base = existing;
	try {
		base = realpathSync(existing);
	} catch {
		// unreadable prefix: fall back to the lexical path
	}
	return rest.length ? join(base, ...rest) : base;
}

export interface PathPolicy {
	roots: string[];
	deny: string[];
}

export function loadPolicy(env: NodeJS.ProcessEnv = process.env): PathPolicy {
	const roots = splitEnv(env.APPLE_MCP_FILE_ROOTS);
	const toAbs = (p: string) => canonical(isAbsolute(p) ? p : join(HOME, p));
	return {
		roots: (roots.length ? roots.map(expandHome) : [HOME]).map(toAbs),
		deny: [...DEFAULT_DENY, ...splitEnv(env.APPLE_MCP_FILE_DENY).map(expandHome)].map(toAbs),
	};
}

export function expandHome(p: string): string {
	if (p === "~") return HOME;
	if (p.startsWith("~/")) return join(HOME, p.slice(2));
	return p;
}

function within(child: string, parent: string): boolean {
	return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Resolve a user-supplied path (absolute, ~-relative, or relative to $HOME) to a canonical
 * absolute path, and throw PathPolicyError unless the policy allows it.
 */
export function resolveAllowedPath(
	input: string,
	_mode: AccessMode,
	policy: PathPolicy = loadPolicy(),
): string {
	if (!input || input.includes("\0")) throw new PathPolicyError("Invalid path");
	const expanded = expandHome(input.trim());
	const abs = canonical(resolve(HOME, expanded));
	const denied = policy.deny.find((d) => within(abs, d));
	if (denied) {
		throw new PathPolicyError(`Access to ${abs} is blocked (protected location ${denied}).`);
	}
	if (!policy.roots.some((r) => within(abs, r))) {
		throw new PathPolicyError(
			`${abs} is outside the allowed roots (${policy.roots.join(", ")}). ` +
				"Set APPLE_MCP_FILE_ROOTS to allow more.",
		);
	}
	return abs;
}

/** True if a path (already canonical) would pass the policy — for filtering search results. */
export function isAllowedPath(abs: string, policy: PathPolicy = loadPolicy()): boolean {
	return (
		!policy.deny.some((d) => within(abs, d)) && policy.roots.some((r) => within(abs, r))
	);
}
