import { execFile } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 15_000;

export class OsaError extends Error {
	constructor(
		message: string,
		readonly kind: "permission" | "timeout" | "not_running" | "script",
	) {
		super(message);
		this.name = "OsaError";
	}
}

export interface RunOptions {
	timeoutMs?: number;
	/** App name used in error messages (e.g. which Automation permission is missing). */
	app?: string;
}

function mapError(stderr: string, killed: boolean, opts: RunOptions): OsaError {
	const app = opts.app ?? "the target app";
	if (killed) {
		return new OsaError(
			`Timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms talking to ${app}.`,
			"timeout",
		);
	}
	if (/-1743|not authori[sz]ed|Not allowed to send Apple events/i.test(stderr)) {
		return new OsaError(
			`No permission to control ${app}. Enable it in System Settings > Privacy & ` +
				"Security > Automation for the app running this server, then retry.",
			"permission",
		);
	}
	if (/-600|isn.t running/i.test(stderr)) {
		return new OsaError(`${app} is not running and could not be launched.`, "not_running");
	}
	// osascript prefixes errors with "execution error: ... (-NNNN)"
	const msg = stderr
		.replace(/^.*?execution error:\s*/s, "")
		.replace(/^(Error:\s*)+/, "")
		.replace(/\s*\(-?\d+\)\s*$/, "")
		.trim();
	return new OsaError(msg || "Unknown osascript error", "script");
}

function osascript(argv: string[], opts: RunOptions): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"osascript",
			argv,
			{ timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) {
					reject(mapError(String(stderr || error.message), Boolean(error.killed), opts));
					return;
				}
				resolve(stdout.trimEnd());
			},
		);
	});
}

/**
 * Run a self-contained JXA function in osascript.
 *
 * `fn` is serialised with toString(), so it must not reference anything outside its own
 * body. `args` travel as a JSON argv string — never interpolated into source — so no
 * escaping is needed. The return value must be JSON-serialisable.
 */
export async function runJxa<A, R>(
	fn: (args: A) => R,
	args: A,
	opts: RunOptions = {},
): Promise<R> {
	const script =
		"function run(argv) {\n" +
		`  var result = (${fn.toString()})(JSON.parse(argv[0]));\n` +
		"  return JSON.stringify(result === undefined ? null : result);\n" +
		"}";
	const out = await osascript(["-l", "JavaScript", "-e", script, JSON.stringify(args)], opts);
	try {
		return JSON.parse(out) as R;
	} catch {
		throw new OsaError(`Unexpected osascript output: ${out.slice(0, 200)}`, "script");
	}
}

/** Escape a value for use inside an AppleScript string literal. */
export function escapeAppleScriptString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n");
}

/** Run raw AppleScript. Interpolate user input only via escapeAppleScriptString. */
export function runAppleScript(script: string, opts: RunOptions = {}): Promise<string> {
	return osascript(["-e", script], opts);
}
