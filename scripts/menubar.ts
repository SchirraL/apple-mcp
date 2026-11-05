import { execFileSync, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { xmlEscape } from "./service.js";

export const BUNDLE_ID = "io.schirra.apple-mcp.menubar";
export const APP_NAME = "Apple MCP";
export const EXECUTABLE = "AppleMCPMenu";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(REPO_ROOT, "menubar");
const BUILD_APP = join(SRC_DIR, "build", `${APP_NAME}.app`);
const INSTALLED_APP = join(homedir(), "Applications", `${APP_NAME}.app`);

/** Info.plist for the menu bar app. Pure so it can be unit-tested. */
export function generateInfoPlist(version: string): string {
	const e = xmlEscape;
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>${BUNDLE_ID}</string>
	<key>CFBundleName</key>
	<string>${APP_NAME}</string>
	<key>CFBundleDisplayName</key>
	<string>${APP_NAME}</string>
	<key>CFBundleExecutable</key>
	<string>${EXECUTABLE}</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>${e(version)}</string>
	<key>CFBundleVersion</key>
	<string>${e(version)}</string>
	<key>LSMinimumSystemVersion</key>
	<string>14.0</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSHighResolutionCapable</key>
	<true/>
</dict>
</plist>
`;
}

function sh(cmd: string, args: string[]): { ok: boolean; out: string } {
	const r = spawnSync(cmd, args, { encoding: "utf8" });
	return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function build(): void {
	const sources = readdirSync(SRC_DIR)
		.filter((f) => f.endsWith(".swift"))
		.map((f) => join(SRC_DIR, f));
	const version = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
	rmSync(BUILD_APP, { recursive: true, force: true });
	mkdirSync(join(BUILD_APP, "Contents/MacOS"), { recursive: true });
	execFileSync(
		"swiftc",
		[
			"-O",
			"-parse-as-library",
			"-swift-version",
			"6",
			"-o",
			join(BUILD_APP, "Contents/MacOS", EXECUTABLE),
			...sources,
		],
		{ stdio: "inherit" },
	);
	writeFileSync(join(BUILD_APP, "Contents/Info.plist"), generateInfoPlist(version));
	execFileSync("codesign", ["--force", "--sign", "-", "--identifier", BUNDLE_ID, BUILD_APP], {
		stdio: "inherit",
	});
	console.log(`Built ${BUILD_APP}`);
}

function quit(): void {
	sh("osascript", ["-e", `quit app id "${BUNDLE_ID}"`]);
	sh("pkill", ["-f", `${APP_NAME}.app/Contents/MacOS/${EXECUTABLE}`]);
}

function install(): void {
	build();
	quit();
	mkdirSync(dirname(INSTALLED_APP), { recursive: true });
	const staging = `${INSTALLED_APP}.new`;
	rmSync(staging, { recursive: true, force: true });
	cpSync(BUILD_APP, staging, { recursive: true });
	rmSync(INSTALLED_APP, { recursive: true, force: true });
	renameSync(staging, INSTALLED_APP);
	sh("open", [INSTALLED_APP]);
	console.log(`Installed ${INSTALLED_APP} and opened it.`);
}

function uninstall(): void {
	quit();
	const agent = join(homedir(), "Library/LaunchAgents", `${BUNDLE_ID}.plist`);
	if (existsSync(agent)) {
		sh("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${BUNDLE_ID}`]);
		rmSync(agent, { force: true });
	}
	rmSync(INSTALLED_APP, { recursive: true, force: true });
	console.log(
		"Removed the app. If 'Apple MCP' still shows in System Settings -> General -> " +
			"Login Items, remove it there.",
	);
}

function open(): number {
	if (!existsSync(INSTALLED_APP)) {
		console.error("Not installed. Run: bun run menubar install");
		return 1;
	}
	return sh("open", [INSTALLED_APP]).ok ? 0 : 1;
}

/** Arguments the menubar commands don't accept (none take any). */
export function unknownArgs(_cmd: string, args: string[]): string[] {
	return [...args];
}

function usage(): number {
	console.error("Usage: menubar.ts <build | install | uninstall | open>");
	return 2;
}

function main(): number {
	const [cmd, ...rest] = process.argv.slice(2);
	const bad = cmd ? unknownArgs(cmd, rest) : [];
	if (bad.length > 0) {
		console.error(`Unknown argument(s) for ${cmd}: ${bad.join(" ")}`);
		return usage();
	}
	switch (cmd) {
		case "build":
			build();
			return 0;
		case "install":
			install();
			return 0;
		case "uninstall":
			uninstall();
			return 0;
		case "open":
			return open();
		default:
			return usage();
	}
}

if (import.meta.main) process.exit(main());
