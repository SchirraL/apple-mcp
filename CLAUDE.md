# apple-mcp (SchirraL fork)

Local MCP server that gives LLM clients access to native macOS apps via AppleScript/JXA.
Soft fork of [dhravya/apple-mcp](https://github.com/dhravya/apple-mcp); Dhravya Shah stays
credited as original author. Goal: replace LMCP (going subscription) for personal use first,
kept clean enough to publish later.

## Commands
- `bun install` — install deps (Bun via Homebrew: `brew install oven-sh/bun/bun`)
- `bun run dev` — run the server on stdio (logs go to stderr; stdout is the MCP channel)
- `bun run build` — bundle to `dist/index.js` (what Claude Desktop / the .dxt runs)
- `bun run typecheck` — `tsc --noEmit`
- `bun run test:unit` — fast unit tests, no real apps touched (dir exists, no tests yet)
- `bun run test` — integration tests against the REAL apps (creates notes/reminders/events;
  never run casually). TODO: gate behind `APPLE_MCP_INTEGRATION=1`
- `bun run inspect` — MCP Inspector against the dev server for manual testing

## Architecture
Current (upstream) layout, to be migrated:
- `index.ts` — one large `CallToolRequest` switch dispatching to `utils/*`
- `tools.ts` — all tool schemas
- `utils/<app>.ts` — AppleScript/JXA per app (contacts, notes, message, mail, reminders,
  calendar, maps, web-search)

Target layout (refactor in progress — move one app at a time, keep behaviour identical):
```
src/
  index.ts            # server bootstrap + registry only
  registry.ts         # collects ToolModules, routes calls
  lib/applescript.ts  # shared runner: timeouts, escaping, error mapping
  lib/safety.ts       # confirm/dry-run helpers
  tools/<app>/
    schema.ts         # input schema + type guards
    handler.ts        # MCP-facing logic
    bridge.ts         # AppleScript/JXA calls (the only part that touches the OS)
```
Each `tools/<app>` exports a `ToolModule { tools, handle }`; adding an app must not require
editing a central switch.

## Roadmap (priority order)
1. Refactor to per-tool modules (above)
2. Full CRUD on core apps: update/delete/complete for Reminders, Calendar, Notes;
   Mail move/flag/reply/drafts
3. Files & Finder: list/search/read files, Finder search, PDF text extraction
4. Shortcuts (list/run/view) and Music (playback, search, playlists)
5. Obsidian (vault list, search, read/write notes) — first third-party app; others later

LMCP's tool set is the reference for scope/naming. Copy capabilities, not code.

## Conventions
- TypeScript strict, ESM, Bun bundler resolution. Tabs for indentation (normalise files you
  touch); lines < 100 chars.
- Explicit types on function params/returns; type guards validate all incoming tool args.
- Tool names: `snake_case` verbs (`list_reminders`, `complete_reminder`). Schemas need
  descriptions good enough for an LLM to pick the right tool unaided.
- All OS access goes through `bridge.ts` → `lib/applescript.ts`. Escape every interpolated
  string (quotes, backslashes, newlines); never build scripts from raw user input.
- Every bridge call has a timeout and returns `{ success, data | error }` with an actionable
  message (e.g. which Automation permission is missing in System Settings).
- Never write to stdout except via the MCP transport — use `console.error` for logs.
- Cap result sizes (limits/pagination) — mailboxes and libraries are huge.

## Safety: destructive & outward-facing actions
Any tool that sends (mail, iMessage), deletes, or overwrites requires `confirm: true`.
Without it, return a preview of exactly what would happen and make no changes. Unit-test both
paths. Creating new items (note, reminder, draft) does not need confirmation.

## Testing
- Unit tests mock `bridge.ts`/the AppleScript runner — that's where most coverage goes.
- Integration tests (`tests/integration`) run only with `APPLE_MCP_INTEGRATION=1`, use
  clearly-prefixed fixtures (`[apple-mcp-test]`) and clean up after themselves.
- Never send real messages/mail in tests; target only the configured test contact/address.

## Clients
- Claude Code: registered via `.mcp.json` in this repo as `apple-mcp-dev` (runs source with Bun).
- Claude Desktop: point `claude_desktop_config.json` at `dist/index.js` or install a built .dxt.
- While LMCP is still installed, its tools overlap with ours — disable it (or the overlapping
  tools) when testing, or the client may call the wrong server.

## Gotchas
- macOS TCC: first run of each app triggers an Automation prompt for the *host* process
  (Terminal, Claude, etc.). Messages history needs Full Disk Access (reads `chat.db`).
- App scripting dictionaries can be pathologically slow (Reminders: 46s for one 500-item
  list). Prefer the native framework via JXA's ObjC bridge (`ObjC.import("EventKit")`) —
  see `src/tools/reminders/bridge.ts` (~0.2s). Measure before choosing.
- JXA/ObjC bridge traps: JS `null` becomes NSNull (use `$()` for nil); JS arrays of ObjC
  objects don't convert back to NSArray; enum/status values come back as strings (`Number()`).
- Functions passed to `runJxa` are serialised with `toString()` and must be self-contained.
  Verify against the minified build (`bun run build` → `node dist/index.js`), not just dev.
- `.dxt` bundles are build artifacts — don't commit them (`*.dxt` is gitignored).
- `manifest.json` (DXT) must stay in sync with registered tools and version.
