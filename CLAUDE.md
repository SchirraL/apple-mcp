# apple-mcp (SchirraL fork)

Local MCP server that gives LLM clients access to native macOS apps via AppleScript/JXA.
Soft fork of [dhravya/apple-mcp](https://github.com/dhravya/apple-mcp); Dhravya Shah stays
credited as original author. Goal: replace LMCP (going subscription) for personal use first,
kept clean enough to publish later.

## Commands
- `bun install` — install deps (Bun via Homebrew: `brew install oven-sh/bun/bun`)
- `bun run dev` — run the server on stdio (logs go to stderr; stdout is the MCP channel)
- `bun run build` — sync `manifest.json` tools/version from the registry, then bundle to
  `dist/index.js` (what Claude Desktop / the .dxt runs)
- `bun run typecheck` — `tsc --noEmit`
- `bun test` — unit tests against fake bridges; never touches real apps
- `bun run inspect` — MCP Inspector against the dev server for manual testing

## Architecture
```
src/
  index.ts            # server bootstrap only
  registry.ts         # the list of ToolModules — add an app here, nothing else
  lib/applescript.ts  # runJxa / runAppleScript: timeouts, escaping, error mapping
  lib/safety.ts       # confirmField + withConfirm (preview unless confirm: true)
  lib/types.ts        # defineTool / toolModule (zod → JSON schema, validation, errors)
  tools/<app>/
    handler.ts        # zod schemas + MCP-facing logic; factory takes a bridge (for tests)
    bridge.ts         # the only code that touches the OS
```
Apps and their backends (chosen by measurement — see Gotchas):
| app | reads | writes |
|---|---|---|
| reminders, calendar | EventKit (JXA ObjC bridge) | EventKit |
| contacts | Contacts framework | Contacts framework |
| notes | Notes scripting (batched) | Notes scripting |
| messages | `chat.db` via `sqlite3 -readonly` | Messages AppleScript |
| mail | `Envelope Index` via `sqlite3 -readonly` | Mail scripting |
| maps | MapKit / CLGeocoder | — (`open_in_maps` opens UI) |

SQLite access: always the system `sqlite3` CLI (`-readonly`, `mode=ro` URI) — never
`bun:sqlite` (the build runs on node). User values go in as hex literals, never raw SQL.
Messages and Mail reads need Full Disk Access for the host process.

## Roadmap (priority order)
1. ~~Refactor to per-tool modules~~ (done 2026-11-05)
2. ~~Full CRUD on core apps~~ (done; contacts has no delete tool yet)
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

## File access policy
Every tool that takes or returns a filesystem path uses `src/lib/paths.ts`:
`resolveAllowedPath(input, mode)` for inputs, `isAllowedPath(abs)` to filter results.
Default root is `$HOME`; secret stores (`~/.ssh`, keychains, cloud CLI creds, raw Mail/
Messages stores, …) are always denied; symlinks are resolved before checking. Configure with
`APPLE_MCP_FILE_ROOTS` / `APPLE_MCP_FILE_DENY` (colon-separated). There is no permanent-delete
tool — only `trash_file` (confirm-gated).

## Testing
- Unit tests (`tests/unit`) use hand-written fake bridges — that's where coverage goes.
- Live checks are manual round-trips with throwaway scripts against the real bridge, using
  `[apple-mcp-test]`-prefixed items that are deleted afterwards. Read-only first.
- Never send real messages/mail in tests; target only the configured test contact/address.

## Clients
- Claude Code: registered via `.mcp.json` in this repo as `apple-mcp-dev` (runs `src/index.ts`).
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
- Recurring calendar events share one id; EventKit resolves a bare id to the series' FIRST
  occurrence. Writes to recurring events therefore require `occurrenceStart`.
- Notes: content is HTML; rewriting `body` can drop attachments, and shared notes change for
  others — such writes are confirm-gated. "Recently Deleted" is a normal folder to scripting
  (only listed when non-empty), recognised by localised name and hidden by default.
- Maps: JXA can't set MKLocalSearch regions (uncatchable NSException), so `near` is weak;
  transit directions give ETA only. A Swift helper would fix both.
- Mail: Gmail folders are labels; ids are Message-ID headers (survive moves); new drafts take
  up to a minute to appear in the index. Contacts: `note` can't be read from osascript.
- JXA out-parameters: passing `Ref()` and reading `out[0]` can segfault osascript (seen with
  NSFileManager trashItemAtURL) — pass `null` when the out value isn't needed.
- `.dxt` bundles are build artifacts — don't commit them (`*.dxt` is gitignored).
- `manifest.json` (DXT) must stay in sync with registered tools and version.
