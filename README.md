# apple-mcp

A local [MCP](https://modelcontextprotocol.io) server that gives Claude (and other MCP
clients) access to the apps on your Mac: Reminders, Calendar, Notes, Messages, Contacts,
Mail, Maps, Files & Finder, PDFs, Shortcuts, Music and Obsidian. 79 tools across 12 apps.
Everything runs on your machine. No cloud relay, no account, no subscription.

This is a fork of [dhravya/apple-mcp](https://github.com/dhravya/apple-mcp) by Dhravya Shah,
substantially rewritten. Each app now has its own module, data is read through native macOS
frameworks and local databases instead of slow AppleScript, and anything that sends,
deletes or overwrites needs explicit confirmation.

## Contents

- [What it can do](#what-it-can-do)
- [Safety model](#safety-model)
- [Requirements](#requirements)
- [Install](#install)
- [Connect a client](#connect-a-client)
- [macOS permissions](#macos-permissions)
- [Configuration](#configuration)
- [Development](#development)
- [Known limitations](#known-limitations)
- [License](#license)

## What it can do

Tools marked with ✋ change or send something, so they return a preview first and only act
when called again with `confirm: true`.

| App | Tools | Backend |
|---|---|---|
| Reminders | `list_reminder_lists`, `list_reminders`, `create_reminder`, `update_reminder`, `complete_reminder`, `delete_reminder` ✋ | EventKit |
| Calendar | `list_calendars`, `list_calendar_events`, `create_calendar_event`, `update_calendar_event`, `delete_calendar_event` ✋ | EventKit |
| Notes | `list_note_folders`, `list_notes`, `read_note`, `create_note`, `update_note` ✋, `delete_note` ✋ | Notes scripting |
| Messages | `list_message_chats`, `read_messages`, `search_messages`, `list_unread_messages`, `send_message` ✋ | `chat.db` (read-only) + Messages |
| Contacts | `search_contacts`, `get_contact`, `list_contacts`, `find_contact_by_phone`, `create_contact`, `update_contact` ✋ | Contacts framework |
| Mail | `list_email_accounts`, `list_email_folders`, `list_emails`, `search_emails`, `read_email`, `create_draft`, `send_email` ✋, `reply_email` ✋, `move_email` ✋, `mark_email_read`, `flag_email` | Mail index (read-only) + Mail |
| Maps | `search_places`, `get_directions`, `open_in_maps` | MapKit |
| Files | `list_files`, `get_file_info`, `read_file`, `write_file` ✋, `create_folder`, `move_file` ✋, `trash_file` ✋ | file system |
| Finder | `search_files`, `list_recent_files`, `get_finder_selection`, `reveal_in_finder`, `get_file_tags`, `set_file_tags` ✋ | Spotlight + Finder |
| PDF | `read_pdf`, `get_pdf_info`, `search_pdf` | PDFKit |
| Shortcuts | `list_shortcuts`, `run_shortcut` ✋, `view_shortcut` | `shortcuts` CLI |
| Music | `music_now_playing`, `music_play`, `music_pause`, `music_next_track`, `music_previous_track`, `music_set_volume`, `music_search_library`, `music_list_playlists`, `music_add_to_playlist`, `music_create_playlist`, `music_remove_from_playlist` ✋ | Music scripting |
| Obsidian | `obsidian_list_vaults`, `obsidian_list_notes`, `obsidian_search_notes`, `obsidian_read_note`, `obsidian_write_note` ✋, `obsidian_daily_note`, `obsidian_open_note` | vault files |

For some tools ✋ applies only in certain cases:
- **Overwrites:** `update_note` replacing a body or touching a note that is shared or has
  attachments, `write_file` / `obsidian_write_note` overwriting an existing file, and
  `update_contact` changing a field that already has a value.
- **Moves and tags:** `move_email` to Trash or Junk, `move_file` onto an existing path, and
  `set_file_tags` removing tags.
- **Replies:** `reply_email` only when it sends instead of saving a draft.

Example requests:

- "What's on my calendar this week? Move the dentist appointment to Friday at 3."
- "Find the email from my landlord about the contract and draft a reply."
- "Which reminders are overdue? Mark the shopping one as done."
- "Search my PDFs for the invoice from March and tell me the total."
- "Append today's meeting notes to my Obsidian daily note."

## Safety model

This server can read your mail and messages and send in your name, so it is built to be
hard to misuse:

- **Confirm before acting.** Sending, deleting, overwriting and moving to Trash return a
  preview of exactly what would happen. Nothing changes until the client calls again with
  `confirm: true`, which Claude does only after showing you the preview.
  - **Shortcuts:** `run_shortcut` is always gated, because a shortcut can do anything.
  - **Recurring events:** writes to a recurring calendar event must name the occurrence.
- **Read-only data access.** Messages and Mail are read straight from their local databases,
  opened read-only. Tool arguments never go into SQL unescaped.
- **File access policy.** File, Finder, PDF and Obsidian tools only reach paths under your
  home folder by default.
  - **Always blocked:** `~/.ssh`, keychains, cloud CLI credentials and the raw Mail and
    Messages stores.
  - **Symlinks** are resolved before checking.
  - **No permanent delete:** `trash_file` moves things to the Trash.
  - **Obsidian** writes can't reach `.obsidian/` (plugins).
- **Service mode is locked down.** It listens on `127.0.0.1` only, requires a random bearer
  token, rejects foreign `Host` headers (DNS rebinding) and refuses requests from browsers.

## Requirements

- macOS (tested on macOS 27). Apple Silicon or Intel.
- [Bun](https://bun.sh) to build: `brew install oven-sh/bun/bun`
- Node.js to run the built server: `brew install node`

## Install

```bash
git clone https://github.com/SchirraL/apple-mcp.git
cd apple-mcp
bun install
bun run build
```

Then choose how clients should reach it.

### Option A: background service (recommended)

Runs one shared instance at login, restarted automatically if it crashes.

```bash
bun run service install
```

This creates the LaunchAgent `io.schirra.apple-mcp`, which serves MCP over HTTP on
`127.0.0.1:47823`. It also creates a bearer token in
`~/Library/Application Support/apple-mcp/token`. Manage it with:

```bash
bun run service status        # launchd state + health check
bun run service restart       # e.g. after `bun run build`
bun run service logs          # ~/Library/Logs/apple-mcp/
bun run service print-config  # ready-to-paste client setup
bun run service uninstall     # add --purge to also delete the token
```

### Option B: stdio (no service)

The client starts its own copy of the server on demand. Simpler, but every client runs a
separate process, and macOS permissions belong to the client app.

## Connect a client

### Claude Code

With the service:

```bash
claude mcp add --transport http --scope user apple-mcp http://127.0.0.1:47823/mcp --header "Authorization: Bearer $(cat ~/Library/Application\ Support/apple-mcp/token)"
```

Without the service:

```bash
claude mcp add --scope user apple-mcp -- node /path/to/apple-mcp/dist/index.js
```

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` and restart Claude
Desktop.

With the service, use the bundled stdio-to-HTTP bridge. It reads the token itself, so the
config contains no secret:

```json
{
  "mcpServers": {
    "apple-mcp": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/path/to/apple-mcp/dist/bridge.js"]
    }
  }
}
```

Without the service, point `args` at `dist/index.js` instead.

> If you also use another Mac MCP server with overlapping tools (for example LMCP), disable
> it. Otherwise the client may call the wrong one.

## macOS permissions

macOS asks once per app. Grant them to the process that runs the server:

- **Service mode:** the `node` binary (`/opt/homebrew/bin/node`). In the file picker it
  resolves to a path like `/opt/homebrew/Cellar/node/<version>/bin/node`.
- **stdio mode:** the client app, such as your terminal or Claude.

| Permission (System Settings → Privacy & Security) | Needed for |
|---|---|
| Full Disk Access | Messages and Mail (reading their local databases) |
| Calendars (Full Access) | Calendar |
| Reminders (Full Access) | Reminders |
| Contacts | Contacts |
| Automation → Notes, Mail, Messages, Music, Finder | writing and app control |

If a tool fails with a permission message, it names the exact setting. After a
`brew upgrade node` you may have to grant the permissions again, because they are tied to the
node binary. Then run `bun run service restart`.

## Configuration

All configuration is through environment variables. For the service, set them in the
LaunchAgent: `APPLE_MCP_PORT` is picked up at `service install` time.

| Variable | Default | Purpose |
|---|---|---|
| `APPLE_MCP_PORT` | `47823` | HTTP port in service mode |
| `APPLE_MCP_TOKEN` | token file | Override the bearer token |
| `APPLE_MCP_FILE_ROOTS` | `$HOME` | Colon-separated folders the file tools may access |
| `APPLE_MCP_FILE_DENY` | (built-in list) | Extra colon-separated folders to block |
| `APPLE_MCP_SHORTCUTS_ALLOW` | (none) | Comma-separated shortcut names or ids that may run without confirmation |

## Development

```bash
bun run dev        # run from source on stdio
bun test           # unit tests (fake bridges; never touch your real data)
bun run typecheck
bun run build      # dist/index.js + dist/bridge.js, and sync manifest.json
bun run inspect    # MCP Inspector against the dev server
```

Layout:

```text
src/
  index.ts            entry point (stdio, or --http for service mode)
  http.ts             local HTTP service: auth, Host/Origin checks
  bridge.ts           stdio-to-HTTP bridge for stdio-only clients
  registry.ts         the list of tool modules
  lib/                osascript runner, confirm gate, path policy, schema helpers
  tools/<app>/
    handler.ts        tool definitions (zod schemas) and logic
    bridge.ts         the only code that touches macOS
scripts/
  service.ts          launchd install/uninstall/status
  sync-manifest.ts    keeps manifest.json in sync with the registry
```

Adding an app means a new `src/tools/<app>/` with a handler, a bridge and a unit test, plus
one line in `src/registry.ts`. `CLAUDE.md` has the conventions and a list of macOS/JXA traps
learned the hard way. Read it before touching a bridge.

## Known limitations

- **Maps:** "near" searches are unreliable from JXA; specific place names work well.
  Directions are real (distance, time, steps); transit gives only an ETA.
- **Mail:**
  - Search covers subject, sender and preview text, not full bodies.
  - New drafts can take a minute to appear in listings.
  - Attachments can't be added yet.
- **Messages:** results show phone numbers and email addresses, not contact names.
  Scheduled sending isn't supported.
- **Contacts:** no delete tool. The notes field isn't readable.
- **Music:** library tools work on the local library only (no Apple Music catalog search).
  Playback and playlist editing haven't been verified on a large library yet.
- **PDF:** scanned PDFs without a text layer aren't OCR'd.
- **Obsidian:** daily notes follow the core Daily Notes plugin. Periodic Notes and Templater
  syntax aren't supported.

## License

MIT. See [LICENSE](LICENSE). Original work © 2025 Dhravya Shah; fork changes by Lars Schirra.
