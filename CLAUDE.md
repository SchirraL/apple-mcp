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
- `bun run service <install|uninstall|status|restart|logs|print-config>` — launchd service

## Architecture
```
src/
  index.ts            # server bootstrap only
  registry.ts         # the list of ToolModules — add an app here, nothing else
  lib/applescript.ts  # runJxa / runAppleScript: timeouts, escaping, error mapping
  lib/safety.ts       # confirmField + withConfirm (preview unless confirm: true)
  lib/types.ts        # defineTool / toolModule (zod → JSON schema, annotations, audit, errors)
  lib/audit.ts        # audit.jsonl writer/reader: allowlisted ids, content as lengths only
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
| files, finder, pdf | node `fs`, `mdfind`, PDFKit | `fs`, NSFileManager (Trash), NSURL tags |
| shortcuts | `shortcuts` CLI (30s cached list) | `shortcuts run` (always confirm-gated unless allowlisted) |
| music | Music scripting (batched) | Music scripting — **unverified on a non-empty library** |
| obsidian | vault files via `fs` (registry: obsidian.json) | `fs`, atomic overwrite |
| doctor, audit | always on (not in `APPLE_MCP_APPS`) | — (read-only) |

SQLite access: always the system `sqlite3` CLI (`-readonly`, `mode=ro` URI) — never
`bun:sqlite` (the build runs on node). User values go in as hex literals, never raw SQL.
Messages and Mail reads need Full Disk Access for the host process.

## Roadmap (priority order)
1. ~~Refactor to per-tool modules~~ (done 2026-11-05)
2. ~~Full CRUD on core apps~~ (done; contacts has no delete tool yet)
3. ~~Files & Finder, PDF~~ (done)
4. ~~Shortcuts, Music~~ (done; Music needs a live round-trip with a real library)
5. ~~Obsidian~~ (done) — more third-party apps later

LMCP's tool set is the reference for scope/naming. Copy capabilities, not code.

## Conventions
- Every `defineTool` declares `effect`: `read` (no side effects), `write` (local changes,
  incl. opening UI), `external` (sends / runs automation). It drives MCP annotations and the
  audit log. A tool with a `confirm` field must not be `read` (a unit test enforces it).
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

## Audit log
Every non-read call that reaches `run()` appends one line to
`~/Library/Logs/apple-mcp/audit.jsonl` (0600, rotates at 5 MB to `.1`): tool, effect,
mode (confirmed / previewed / direct), outcome, ms, target. The target comes from an
ALLOWLIST of identifier keys in `src/lib/audit.ts`; content keys (body, subject, title, name,
notes, query, …) are logged as lengths; unknown keys are dropped. Error text is passed through
`redactArgs` (argument values replaced). When adding a tool whose args carry personal data
under an allowlisted key (e.g. addresses in `from`/`to`), give it an `auditTarget`. Logging is
a no-op under `bun test` unless `APPLE_MCP_AUDIT_LOG` points elsewhere.

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

## Service mode (launchd)
`node dist/index.js --http` serves MCP Streamable HTTP (stateless, JSON responses) on
`127.0.0.1:47823/mcp` (`APPLE_MCP_PORT`). Gates in `src/http.ts`: Host allowlist (DNS
rebinding), any browser `Origin` refused, bearer token from
`~/Library/Application Support/apple-mcp/token` (0600; never in the plist or logs).
`GET /health` is unauthenticated (reports version, tool count, enabled apps).
`APPLE_MCP_APPS` (comma-separated module names, unset = all) limits which apps register;
unknown names fail at startup. The LaunchAgent `io.schirra.apple-mcp` starts it at login
and restarts it on crash; logs in `~/Library/Logs/apple-mcp/`. After code changes:
`bun run build && bun run service restart`.
Under launchd, macOS privacy permissions belong to the **node binary** (Full Disk Access,
Calendars, Reminders, Contacts, Automation) — not the terminal. The plist therefore runs a
pinned copy, `~/Library/Application Support/apple-mcp/runtime/node` (`service install`
never overwrites it; `service update-node --yes` replaces it). Homebrew's node can't be
pinned: it loads libnode + Homebrew dylibs by path, and its signature is ad-hoc (designated
requirement = cdhash, so every upgrade loses grants). Use the nodejs.org build (Developer
ID, team HX7739G8FX: grants are tied to identifier + team). Install never silently falls
back to another node on PATH; it names candidates and asks for `--node`. Every
`APPLE_MCP_*` var at install time goes into the plist, except `APPLE_MCP_TOKEN`.
`service doctor` / `apple_mcp_doctor` / `node dist/index.js --doctor` report permission
status without prompting: EventKit/CNContactStore authorizationStatus, FDA by reading 16
bytes of chat.db / Envelope Index, Automation via `AEDeterminePermissionToAutomateTarget`
(askUserIfNeeded=false; needs `ObjC.bindFunction` with `^v` — the default binding rejects
the AEDesc; -600 = app not running, never launched). Run from a terminal, TCC attributes
to the terminal (responsible process), so only the MCP tool via the service shows the
service's real view. `dist/bridge.js` is a stdio⇄HTTP bridge for
stdio-only clients (Claude Desktop); it reads the token itself.

## Menu bar app (`menubar/`)
SwiftUI `MenuBarExtra` (LSUIElement, ad-hoc signed, bundle id `io.schirra.apple-mcp.menubar`),
built by `bun run menubar <build|install|uninstall|open>` with plain `swiftc` (no Xcode
project; CI compiles it). It only talks to the service: GET /health every 10 s, the
`apple_mcp_doctor` tool via POST /mcp with the token read per call (never logged), audit.jsonl
for recent activity, `launchctl` for restart/stop/start (Stop asks first). Down notification
after 2 failed polls, suppressed for Stop/Restart from the menu; UserNotifications with an
`osascript` fallback. Debug: `AppleMCPMenu --dump-state`, `--test-notify`. Login item via
SMAppService.

## Clients
- Claude Code: registered via `.mcp.json` in this repo as `apple-mcp-dev` (runs `src/index.ts`).
- Claude Desktop: `dist/bridge.js` → service (see `bun run service print-config`), or stdio
  `dist/index.js` directly.
- Claude Code (service): `claude mcp add --transport http --scope user apple-mcp …` from
  `print-config`.
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
- Music JXA: `whose({_or: …})` fails ("Can't convert types") and batched reads on an empty
  track list throw "Can't get object" — check `.length` first, filter in JS.
- Tool names are global: Obsidian tools are `obsidian_*`, Music `music_*` (registry throws on
  duplicates). Obsidian refuses dot-segments in note paths so writes can't reach
  `.obsidian/plugins`.
- TCC for a launchd binary: only Full Disk Access has a "+" button. Calendars, Reminders,
  Contacts and Automation list the binary only after its first request, so after
  `service install`/`update-node` call list_calendars, list_reminder_lists, list_contacts
  through the service and click Allow. The 15s bridge timeout fires while the prompt is open
  — the second call succeeds. Running the pinned node from a terminal won't help (TCC
  attributes it to the terminal).
- `.dxt` bundles are build artifacts — don't commit them (`*.dxt` is gitignored).
- `manifest.json` (DXT) must stay in sync with registered tools and version.
