// Regenerates manifest.json "tools" (DXT) from the tools the server actually registers.
// Runs as part of `bun run build`.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registeredTools } from "../src/registry.js";

const path = join(import.meta.dir, "..", "manifest.json");
const manifest = JSON.parse(readFileSync(path, "utf8"));
const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));

manifest.version = pkg.version;
manifest.tools = registeredTools.map((t) => ({
	name: t.name,
	description: t.description,
}));

const next = `${JSON.stringify(manifest, null, "\t")}\n`;
if (next !== readFileSync(path, "utf8")) {
	writeFileSync(path, next);
	console.error(`manifest.json updated (${manifest.tools.length} tools)`);
}
