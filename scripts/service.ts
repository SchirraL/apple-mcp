import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	CONFIG_DIR,
	HEALTH_PATH,
	HOST,
	LOG_DIR,
	SERVICE_LABEL,
	getOrCreateToken,
	servicePort,
	serviceUrl,
} from "../src/lib/service-config.js";

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
}

/** Build the launchd plist. Never includes the bearer token. */
export function generatePlist(o: PlistOptions): string {
	const e = xmlEscape;
	const env: [string, string][] = [["PATH", o.pathEnv ?? SERVICE_PATH]];
	if (o.port) env.push(["APPLE_MCP_PORT", o.port]);
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

async function resolveNode(): Promise<NodeResolution> {
	let found = process.execPath;
	if (/bun$/.test(found) || !/node/.test(found)) {
		try {
			found = (await run("which", ["node"])).stdout.trim();
		} catch {
			throw new Error("node not found in PATH (the service runs dist/index.js with node)");
		}
	}
	return stabiliseNodePath(found);
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

async function install(): Promise<number> {
	if (!existsSync(DIST)) {
		console.error(`${DIST} not found — run \`bun run build\` first.`);
		return 1;
	}
	const node = await resolveNode();
	if (node.warning) console.warn(`Warning: ${node.warning}`);
	getOrCreateToken();
	mkdirSync(LOG_DIR, { recursive: true });
	mkdirSync(dirname(PLIST_PATH), { recursive: true });
	writeFileSync(
		PLIST_PATH,
		generatePlist({
			label: SERVICE_LABEL,
			nodePath: node.path,
			scriptPath: DIST,
			workingDirectory: REPO_ROOT,
			logDir: LOG_DIR,
			port: process.env.APPLE_MCP_PORT,
		}),
	);
	console.log(`Wrote ${PLIST_PATH} (node: ${node.path})`);
	await launchctl("bootout", target()); // ignore failure: may not be loaded
	const boot = await launchctl("bootstrap", domain(), PLIST_PATH);
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
	const node = await resolveNode();
	console.log("# Claude Code");
	console.log(claudeCodeCommand(serviceUrl(), token));
	console.log("\n# Claude Desktop (claude_desktop_config.json) — bridge reads the token itself");
	console.log(desktopConfig(node.path, BRIDGE));
	return 0;
}

async function main(): Promise<number> {
	const [cmd, ...rest] = process.argv.slice(2);
	switch (cmd) {
		case "install":
			return install();
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
			console.error("Usage: service.ts <install|uninstall|status|restart|logs|print-config>");
			return 2;
	}
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
