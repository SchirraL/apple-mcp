import { execFile } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	CONFIG_DIR,
	HEALTH_PATH,
	HOST,
	LOG_DIR,
	PINNED_NODE,
	SERVICE_LABEL,
	getOrCreateToken,
	servicePort,
	serviceUrl,
} from "../src/lib/service-config.js";
import { doctorBridge } from "../src/tools/doctor/bridge.js";
import { type DoctorReport, formatReport, runDoctor } from "../src/tools/doctor/handler.js";

const run = promisify(execFile);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(REPO_ROOT, "dist/index.js");
const BRIDGE = join(REPO_ROOT, "dist/bridge.js");
const PLIST_PATH = join(homedir(), "Library/LaunchAgents", `${SERVICE_LABEL}.plist`);
const SERVICE_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

// ---------- pure helpers (exported for tests) ----------

export function xmlEscape(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export interface PlistOptions {
	label: string;
	nodePath: string;
	scriptPath: string;
	workingDirectory: string;
	logDir: string;
	port?: string;
	pathEnv?: string;
	/** Extra environment for the service; only APPLE_MCP_* (never _TOKEN) is written. */
	env?: Record<string, string | undefined>;
}

/** The APPLE_MCP_* variables that may go into the plist. The token is never included. */
export function collectPlistEnv(
	env: Record<string, string | undefined>,
): { vars: Record<string, string>; tokenIgnored: boolean } {
	const vars: Record<string, string> = {};
	for (const key of Object.keys(env).sort()) {
		const value = env[key];
		if (!key.startsWith("APPLE_MCP_") || key === "APPLE_MCP_TOKEN" || value === undefined) {
			continue;
		}
		vars[key] = value;
	}
	return { vars, tokenIgnored: Boolean(env.APPLE_MCP_TOKEN) };
}

/** Build the launchd plist. Never includes the bearer token. */
export function generatePlist(o: PlistOptions): string {
	const e = xmlEscape;
	const env: [string, string][] = [["PATH", o.pathEnv ?? SERVICE_PATH]];
	const extra = collectPlistEnv({ ...(o.port ? { APPLE_MCP_PORT: o.port } : {}), ...o.env }).vars;
	for (const [k, v] of Object.entries(extra)) env.push([k, v]);
	const envXml = env
		.map(([k, v]) => `\t\t<key>${e(k)}</key>\n\t\t<string>${e(v)}</string>`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${e(o.label)}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${e(o.nodePath)}</string>
		<string>${e(o.scriptPath)}</string>
		<string>--http</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>WorkingDirectory</key>
	<string>${e(o.workingDirectory)}</string>
	<key>StandardOutPath</key>
	<string>${e(join(o.logDir, "stdout.log"))}</string>
	<key>StandardErrorPath</key>
	<string>${e(join(o.logDir, "stderr.log"))}</string>
	<key>EnvironmentVariables</key>
	<dict>
${envXml}
	</dict>
</dict>
</plist>
`;
}

export interface NodeResolution {
	path: string;
	warning?: string;
}

/**
 * Prefer a stable symlink over a versioned Homebrew Cellar path so node upgrades keep the
 * same path. `exists` is injectable for tests.
 */
export function stabiliseNodePath(
	resolved: string,
	exists: (p: string) => boolean = existsSync,
): NodeResolution {
	if (!/\/Cellar\//.test(resolved)) return { path: resolved };
	const candidates = resolved.startsWith("/usr/local/")
		? ["/usr/local/bin/node", "/opt/homebrew/bin/node"]
		: ["/opt/homebrew/bin/node", "/usr/local/bin/node"];
	const stable = candidates.find((c) => exists(c));
	if (!stable) return { path: resolved };
	return {
		path: stable,
		warning:
			`Using ${stable} instead of the versioned Cellar path. macOS privacy permissions ` +
			"(Automation, Full Disk Access) are granted to that node binary and may need " +
			"re-granting after node upgrades.",
	};
}

/** Node path the plist runs (first ProgramArguments entry), or undefined. */
export function plistNodePath(xml: string): string | undefined {
	const m = xml.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/);
	if (!m?.[1]) return undefined;
	return m[1]
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

export interface PinOptions {
	pinned?: string;
	runtimeDir?: string;
	/** Replace an existing pinned copy (changes the binary's identity for macOS TCC). */
	replace?: boolean;
	/** Throws if the copy is unusable. Default: `codesign -v` plus `--version`. */
	verify?: (file: string) => Promise<void>;
}

export interface PinResult {
	path: string;
	action: "created" | "reused" | "replaced";
}

/**
 * Copy `source` to the pinned location. An existing copy is left untouched unless `replace`
 * is set: overwriting changes the binary's identity and macOS drops its privacy grants.
 * The copy is verified under a temporary name and renamed into place, so a bad copy never
 * replaces a working one.
 */
export async function pinNode(source: string, opts: PinOptions = {}): Promise<PinResult> {
	const pinned = opts.pinned ?? PINNED_NODE;
	const dir = opts.runtimeDir ?? dirname(pinned);
	const exists = existsSync(pinned);
	if (exists && !opts.replace) return { path: pinned, action: "reused" };
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const tmp = `${pinned}.new`;
	try {
		copyFileSync(realpathSync(source), tmp);
		chmodSync(tmp, 0o755);
		await (opts.verify ?? verifyNodeCopy)(tmp);
		renameSync(tmp, pinned);
	} finally {
		rmSync(tmp, { force: true });
	}
	return { path: pinned, action: exists ? "replaced" : "created" };
}

/** A copy is usable if its code signature is valid and it runs standalone. */
export async function verifyNodeCopy(file: string): Promise<void> {
	try {
		await run("codesign", ["-v", file], { timeout: 15_000 });
	} catch (error) {
		throw new Error(`code signature invalid after copy: ${(error as Error).message}`);
	}
	let version: string;
	try {
		version = (await run(file, ["--version"], { timeout: 15_000 })).stdout.trim();
	} catch (error) {
		throw new Error(
			"the copy does not run on its own (Homebrew's node loads libnode and other " +
				"Homebrew dylibs relative to its install tree, so it cannot be relocated). " +
				`Use a self-contained node, e.g. the nodejs.org installer: ${(error as Error).message}`,
		);
	}
	if (!nodeVersionOk(version)) {
		throw new Error(
			`node ${version} is too old: the server needs node >= ${MIN_NODE_MAJOR} ` +
				"(the MCP SDK uses the global Web Crypto API). Install the nodejs.org LTS.",
		);
	}
}

export const MIN_NODE_MAJOR = 20;

/** True for `v20.0.0` and later. */
export function nodeVersionOk(version: string): boolean {
	const major = Number(/^v?(\d+)\./.exec(version.trim())?.[1]);
	return Number.isInteger(major) && major >= MIN_NODE_MAJOR;
}

export function claudeCodeCommand(url: string, token: string): string {
	return (
		`claude mcp add --transport http --scope user apple-mcp ${url} ` +
		`--header "Authorization: Bearer ${token}"`
	);
}

export function desktopConfig(nodePath: string, bridgePath: string): string {
	return JSON.stringify(
		{ mcpServers: { "apple-mcp": { command: nodePath, args: [bridgePath] } } },
		null,
		2,
	);
}

/** Pull state / pid / last exit code out of `launchctl print` output. */
export function summariseLaunchctl(output: string): {
	state?: string;
	pid?: string;
	lastExit?: string;
} {
	const pick = (re: RegExp): string | undefined => output.match(re)?.[1]?.trim();
	return {
		state: pick(/^\s*state = (.+)$/m),
		pid: pick(/^\s*pid = (\d+)$/m),
		lastExit: pick(/^\s*last exit (?:code|status) = (.+)$/m),
	};
}

export function tail(text: string, lines: number): string {
	const all = text.split("\n");
	if (all[all.length - 1] === "") all.pop();
	return all.slice(-lines).join("\n");
}

// ---------- side-effecting commands ----------

const uid = (): number => process.getuid?.() ?? 501;
const domain = (): string => `gui/${uid()}`;
const target = (): string => `${domain()}/${SERVICE_LABEL}`;

async function launchctl(...args: string[]): Promise<{ ok: boolean; out: string }> {
	try {
		const { stdout, stderr } = await run("launchctl", args);
		return { ok: true, out: stdout + stderr };
	} catch (error) {
		const e = error as { stdout?: string; stderr?: string; message: string };
		return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` || e.message };
	}
}

/** Candidate node binaries to pin, best first: --node flag, else every node on PATH. */
async function nodeCandidates(flag?: string): Promise<string[]> {
	if (flag) return [flag];
	const found: string[] = [];
	if (/node$/.test(process.execPath)) found.push(process.execPath);
	try {
		found.push(...(await run("which", ["-a", "node"])).stdout.split("\n").filter(Boolean));
	} catch {
		// no node on PATH
	}
	const real = found.flatMap((p) => {
		try {
			return [realpathSync(p)];
		} catch {
			return [];
		}
	});
	return [...new Set(real)];
}

/** True if a copy of `node` verifies (signature + runs standalone). Uses a throwaway dir. */
async function isRelocatable(node: string): Promise<boolean> {
	const dir = mkdtempSync(join(tmpdir(), "apple-mcp-node-"));
	try {
		await pinNode(node, { pinned: join(dir, "node"), runtimeDir: dir });
		return true;
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function nodeVersion(node: string): Promise<string> {
	try {
		return (await run(node, ["--version"], { timeout: 15_000 })).stdout.trim();
	} catch {
		return "unknown version";
	}
}

function flagValue(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

function warnEnv(): Record<string, string> {
	const { vars, tokenIgnored } = collectPlistEnv(process.env);
	if (tokenIgnored) {
		console.warn(
			"Warning: APPLE_MCP_TOKEN is ignored for the service (never written to the plist); " +
				"the token file is used.",
		);
	}
	return vars;
}

async function pinFromCandidates(flag: string | undefined, replace: boolean): Promise<PinResult> {
	if (!replace && existsSync(PINNED_NODE)) {
		if (flag) console.warn(`Ignoring --node: ${PINNED_NODE} exists (use update-node to swap).`);
		return pinNode(PINNED_NODE);
	}
	const candidates = await nodeCandidates(flag);
	const [first] = candidates;
	if (!first) throw new Error("No node found in PATH. Pass one with --node <path>.");
	try {
		return await pinNode(first, { replace });
	} catch (error) {
		// Never silently fall back to a different node (other version, other TCC identity):
		// name the usable alternatives and let the user choose with --node.
		const usable: string[] = [];
		for (const c of candidates.slice(1)) {
			if (await isRelocatable(c)) usable.push(`${c} (${await nodeVersion(c)})`);
		}
		throw new Error(
			`Could not pin ${first}: ${(error as Error).message}\n` +
				(usable.length > 0
					? `Self-contained nodes found: ${usable.join(", ")}.\n`
					: "No self-contained node found on PATH.\n") +
				"Install the nodejs.org build (Developer ID-signed; its privacy grants survive " +
				"node updates) and pass it with --node <path>.",
		);
	}
}

interface Health {
	ok: boolean;
	detail: string;
}

async function checkHealth(): Promise<Health> {
	const url = `http://${HOST}:${servicePort()}${HEALTH_PATH}`;
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
		const body = await res.text();
		return { ok: res.ok, detail: `${res.status} ${body.trim()}` };
	} catch (error) {
		return { ok: false, detail: `unreachable (${(error as Error).message})` };
	}
}

async function writePlistAndStart(nodePath: string): Promise<number> {
	const envVars = warnEnv();
	mkdirSync(LOG_DIR, { recursive: true });
	mkdirSync(dirname(PLIST_PATH), { recursive: true });
	writeFileSync(
		PLIST_PATH,
		generatePlist({
			label: SERVICE_LABEL,
			nodePath,
			scriptPath: DIST,
			workingDirectory: REPO_ROOT,
			logDir: LOG_DIR,
			env: envVars,
		}),
	);
	const names = Object.keys(envVars);
	console.log(`Wrote ${PLIST_PATH} (node: ${nodePath}; env: ${names.join(", ") || "none"})`);
	await launchctl("bootout", target()); // ignore failure: may not be loaded
	// bootout returns before the job is gone; bootstrapping too early fails with
	// "Bootstrap failed: 5: Input/output error". Wait for it, then retry a few times.
	for (let i = 0; i < 20 && (await launchctl("print", target())).ok; i++) {
		await new Promise((r) => setTimeout(r, 250));
	}
	let boot = await launchctl("bootstrap", domain(), PLIST_PATH);
	for (let i = 0; i < 3 && !boot.ok; i++) {
		await new Promise((r) => setTimeout(r, 1000));
		boot = await launchctl("bootstrap", domain(), PLIST_PATH);
	}
	if (!boot.ok) {
		console.error(`launchctl bootstrap failed:\n${boot.out}`);
		return 1;
	}
	for (let i = 0; i < 20; i++) {
		const health = await checkHealth();
		if (health.ok) {
			console.log(`Service is up: ${health.detail}`);
			console.log("Run `bun run scripts/service.ts print-config` for client setup.");
			return 0;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	console.error(`Service did not become healthy within ~10s. Check logs:`);
	console.error("  bun run scripts/service.ts logs");
	return 1;
}

async function install(args: string[]): Promise<number> {
	if (!existsSync(DIST)) {
		console.error(`${DIST} not found — run \`bun run build\` first.`);
		return 1;
	}
	const pin = await pinFromCandidates(flagValue(args, "--node"), false);
	if (pin.action === "reused") {
		console.log(`Reusing pinned node ${pin.path} (not overwritten: keeps its privacy grants).`);
	} else {
		console.log(`Pinned node runtime: ${pin.path}`);
		printGrantList(pin.path);
	}
	getOrCreateToken();
	return writePlistAndStart(pin.path);
}

function printGrantList(path: string): void {
	console.log(
		"macOS privacy permissions belong to this exact binary. In System Settings > Privacy &\n" +
			"Security, add/enable it under: Full Disk Access, Calendars, Reminders, Contacts,\n" +
			`Automation (prompted on first use per app).\n  ${path}`,
	);
}

async function updateNode(args: string[]): Promise<number> {
	if (!existsSync(DIST)) {
		console.error(`${DIST} not found — run \`bun run build\` first.`);
		return 1;
	}
	console.warn(
		"WARNING: replacing the pinned node changes the binary macOS grants privacy permissions\n" +
			"to. ALL of these must be re-granted to the new binary afterwards:\n" +
			"  Full Disk Access, Calendars, Reminders, Contacts, Automation (per app)\n" +
			`  ${PINNED_NODE}`,
	);
	if (!args.includes("--yes")) {
		console.error("Not replacing. Re-run with --yes to confirm.");
		return 2;
	}
	const pin = await pinFromCandidates(flagValue(args, "--node"), true);
	console.log(`Pinned node ${pin.action}: ${pin.path}`);
	printGrantList(pin.path);
	getOrCreateToken();
	return writePlistAndStart(pin.path);
}

async function uninstall(purge: boolean): Promise<number> {
	const res = await launchctl("bootout", target());
	if (!res.ok) console.log(`bootout: ${res.out.trim() || "not loaded"}`);
	if (existsSync(PLIST_PATH)) {
		rmSync(PLIST_PATH);
		console.log(`Removed ${PLIST_PATH}`);
	}
	if (purge) {
		rmSync(CONFIG_DIR, { recursive: true, force: true });
		console.log(`Removed ${CONFIG_DIR} (token)`);
	} else {
		console.log("Token kept (use --purge to delete it).");
	}
	return 0;
}

async function status(): Promise<number> {
	const res = await launchctl("print", target());
	if (res.ok) {
		const s = summariseLaunchctl(res.out);
		console.log(`launchd: state=${s.state ?? "?"} pid=${s.pid ?? "-"} last exit=${s.lastExit ?? "-"}`);
	} else {
		console.log("launchd: not loaded (run `bun run scripts/service.ts install`)");
	}
	const used = existsSync(PLIST_PATH) ? plistNodePath(readFileSync(PLIST_PATH, "utf8")) : undefined;
	if (!used) {
		console.log("node: unknown (no plist)");
	} else if (used === PINNED_NODE) {
		console.log(`node: ${used} (pinned)`);
	} else {
		console.log(
			`node: ${used} (NOT the pinned runtime ${PINNED_NODE} — ` +
				"run `service install` or `service update-node --yes`)",
		);
	}
	const health = await checkHealth();
	console.log(`health: ${health.ok ? "ok" : "FAILED"} — ${health.detail}`);
	return res.ok && health.ok ? 0 : 1;
}

async function restart(): Promise<number> {
	const res = await launchctl("kickstart", "-k", target());
	console.log(res.ok ? "Restarted." : `kickstart failed:\n${res.out}`);
	return res.ok ? 0 : 1;
}

function logs(): number {
	for (const name of ["stdout.log", "stderr.log"]) {
		const file = join(LOG_DIR, name);
		console.log(`==> ${file} <==`);
		console.log(existsSync(file) ? tail(readFileSync(file, "utf8"), 50) : "(no file)");
	}
	return 0;
}

async function printConfig(): Promise<number> {
	const token = getOrCreateToken();
	const nodePath = existsSync(PINNED_NODE) ? PINNED_NODE : ((await nodeCandidates())[0] ?? "node");
	console.log("# Claude Code");
	console.log(claudeCodeCommand(serviceUrl(), token));
	console.log("\n# Claude Desktop (claude_desktop_config.json) — bridge reads the token itself");
	console.log(desktopConfig(nodePath, BRIDGE));
	return 0;
}

async function doctor(args: string[]): Promise<number> {
	let report: DoctorReport;
	if (args.includes("--pinned")) {
		if (!existsSync(PINNED_NODE) || !existsSync(DIST)) {
			console.error("Needs the pinned node and a built dist/index.js (install first).");
			return 1;
		}
		const { stdout } = await run(PINNED_NODE, [DIST, "--doctor", "--json"], { timeout: 60_000 });
		report = JSON.parse(stdout) as DoctorReport;
	} else {
		report = await runDoctor(doctorBridge);
	}
	console.log(formatReport(report));
	if (!args.includes("--pinned")) {
		console.log(
			"\nThis is the view of the process running this command, not of the launchd service.\n" +
				"For the service's own view call the MCP tool `apple_mcp_doctor` through the service.",
		);
	}
	return report.checks.some((c) => c.status === "denied") ? 1 : 0;
}

const FLAGS: Record<string, { bool: string[]; value: string[] }> = {
	install: { bool: [], value: ["--node"] },
	"update-node": { bool: ["--yes"], value: ["--node"] },
	doctor: { bool: ["--pinned", "--json"], value: [] },
	uninstall: { bool: ["--purge"], value: [] },
};

/** Arguments a command doesn't accept (e.g. --help), so they never reach an install. */
export function unknownArgs(cmd: string, args: string[]): string[] {
	const f = FLAGS[cmd] ?? { bool: [], value: [] };
	const bad: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i] as string;
		if (f.value.includes(a) && i + 1 < args.length) i++;
		else if (!f.bool.includes(a)) bad.push(a);
	}
	return bad;
}

async function main(): Promise<number> {
	const [cmd, ...rest] = process.argv.slice(2);
	const bad = cmd ? unknownArgs(cmd, rest) : [];
	if (bad.length > 0) {
		console.error(`Unknown argument(s) for ${cmd}: ${bad.join(" ")}`);
		return usage();
	}
	switch (cmd) {
		case "install":
			return install(rest);
		case "update-node":
			return updateNode(rest);
		case "doctor":
			return doctor(rest);
		case "uninstall":
			return uninstall(rest.includes("--purge"));
		case "status":
			return status();
		case "restart":
			return restart();
		case "logs":
			return logs();
		case "print-config":
			return printConfig();
		default:
			return usage();
	}
}

function usage(): number {
	console.error(
		"Usage: service.ts <install [--node <path>] | update-node [--node <path>] --yes |\n" +
			"  uninstall [--purge] | status | restart | logs | print-config |\n" +
			"  doctor [--pinned] [--json]>",
	);
	return 2;
}

if (import.meta.main) {
	main().then(
		(code) => process.exit(code),
		(error) => {
			console.error(error instanceof Error ? error.message : error);
			process.exit(1);
		},
	);
}
