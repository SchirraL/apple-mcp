import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Shared conventions for running apple-mcp as a local HTTP service (launchd) and for the
// clients/bridge that talk to it. Keep in sync with scripts/service.ts and src/bridge.ts.

export const SERVICE_LABEL = "io.schirra.apple-mcp";
export const DEFAULT_PORT = 47823;
export const HOST = "127.0.0.1";
export const MCP_PATH = "/mcp";
export const HEALTH_PATH = "/health";

export const CONFIG_DIR = join(homedir(), "Library/Application Support/apple-mcp");
export const TOKEN_FILE = join(CONFIG_DIR, "token");
export const LOG_DIR = join(homedir(), "Library/Logs/apple-mcp");

export function servicePort(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.APPLE_MCP_PORT;
	if (!raw) return DEFAULT_PORT;
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 1024 || port > 65535) {
		throw new Error(`APPLE_MCP_PORT must be an integer 1024–65535, got "${raw}"`);
	}
	return port;
}

export function serviceUrl(env: NodeJS.ProcessEnv = process.env): string {
	return `http://${HOST}:${servicePort(env)}${MCP_PATH}`;
}

/** Read the bearer token (APPLE_MCP_TOKEN wins), creating a random one if none exists. */
export function getOrCreateToken(env: NodeJS.ProcessEnv = process.env): string {
	if (env.APPLE_MCP_TOKEN) return env.APPLE_MCP_TOKEN;
	if (existsSync(TOKEN_FILE)) {
		const token = readFileSync(TOKEN_FILE, "utf8").trim();
		if (token.length >= 32) return token;
	}
	mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
	chmodSync(CONFIG_DIR, 0o700);
	const token = randomBytes(32).toString("base64url");
	writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
	chmodSync(TOKEN_FILE, 0o600);
	return token;
}

// Pinned node runtime. macOS privacy permissions (TCC) are bound to the binary that runs the
// service, so the service uses a private copy that package-manager upgrades cannot replace.
export const RUNTIME_DIR = join(CONFIG_DIR, "runtime");
export const PINNED_NODE = join(RUNTIME_DIR, "node");
