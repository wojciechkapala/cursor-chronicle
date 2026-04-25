# cursor-chronicle

> Bring [Codex Chronicle](https://github.com/openai/codex)'s screen-recording memory into Cursor. Ask Cursor *"what was I doing 5 hours ago?"* or *"when did I last touch the auth bug?"* and get a real answer.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.3.0-blue.svg)](CHANGELOG.md)
[![Cursor plugin](https://img.shields.io/badge/Cursor-plugin-7C3AED.svg)](https://cursor.com/docs/plugins)

Codex Chronicle (an OpenAI Codex feature) passively records your screen, runs OCR, and writes a markdown summary every ~10 minutes describing what you have been doing across your apps. **cursor-chronicle** is a [Cursor plugin](https://cursor.com/docs/plugins) that ships everything Cursor needs to plug those summaries into the model: a `sessionStart` hook, an MCP server, and an always-on rule.

It is the Cursor counterpart of [`claude-chronicle`](https://github.com/wojciechkapala/claude-chronicle) — same data source, same behaviour, packaged as a proper Cursor plugin.

## How it works

The repo is a self-contained Cursor plugin (`.cursor-plugin/plugin.json` at the root). Cursor auto-discovers all three components when the plugin loads:

| Concern | Mechanism | Path inside the plugin |
|---|---|---|
| **Bootstrap context at session start** — 3 freshest 10-min summaries in full + manifest of every Chronicle entry + live-recording state | `sessionStart` hook returning `additional_context` | `hooks/hooks.json` + `hooks/session-start.js` |
| **On-demand recall by time / topic / both** — incl. read a single entry, inspect live screen | MCP server with 5 tools | `mcp.json` + `src/server.js` |
| **Tell the agent when to use which tool** | Always-on rule | `rules/cursor-chronicle.mdc` |

The MCP server exposes:

- `chronicle_recent` — last N 10-min summaries as full markdown.
- `chronicle_manifest` — table of every entry (timestamp, age, kind, path).
- `chronicle_search` — by free-text query and/or time window.
- `chronicle_read_entry` — full body of one entry, with the noisy `## Recording summary` and `## Citations` sections stripped.
- `chronicle_live_state` — pidfile health, freshest screen frame per display, OCR sidecar locations.

Together, the hook handles the always-injected bootstrap that `claude-chronicle`'s `SessionStart` hook handles, and the MCP server handles the on-demand recall that `claude-chronicle`'s `/remind` skill handles.

## Prerequisites

- macOS or Linux
- Node.js **18+**
- [Codex CLI](https://github.com/openai/codex) installed and Chronicle enabled, writing to `~/.codex/memories_extensions/chronicle/resources/`
- (Optional) `rg` (ripgrep) on `PATH` for fast keyword search; falls back to a JS-side scan if missing

## Install

### Recommended: install as a local Cursor plugin (one command)

Cursor auto-discovers any plugin under `~/.cursor/plugins/local/`. Clone the repo straight into that path and install the runtime:

```bash
git clone https://github.com/wojciechkapala/cursor-chronicle.git \
  ~/.cursor/plugins/local/cursor-chronicle
cd ~/.cursor/plugins/local/cursor-chronicle
npm install
```

Restart Cursor. The plugin manifest at `.cursor-plugin/plugin.json`, the rule under `rules/`, the hook under `hooks/`, and the MCP server declared in `mcp.json` will be discovered automatically. Verify in **Settings → Plugins** that `cursor-chronicle` is listed and enabled, and in **Settings → Features → Model Context Protocol** that the server has 5 tools (`chronicle_recent`, `chronicle_manifest`, `chronicle_search`, `chronicle_read_entry`, `chronicle_live_state`).

### Alternative: clone elsewhere and symlink

If you keep your code under a different directory, clone there and symlink:

```bash
git clone https://github.com/wojciechkapala/cursor-chronicle.git ~/code/cursor-chronicle
cd ~/code/cursor-chronicle && npm install
mkdir -p ~/.cursor/plugins/local
ln -s ~/code/cursor-chronicle ~/.cursor/plugins/local/cursor-chronicle
```

### Future: Cursor Marketplace

Once the plugin is reviewed and listed at [cursor.com/marketplace](https://cursor.com/marketplace), users will be able to install it with one click — no clone, no `npm install`. Until then, use the local path above.

## Usage

Once the MCP server is registered and the rule is loaded, just talk to Cursor in natural language:

| English | Polski |
|---|---|
| "What was I doing 5 hours ago?" | "Co robiłem 5 godzin temu?" |
| "When did I last touch the auth bug?" | "Kiedy ostatnio patrzyłem na ten bug z auth?" |
| "What did I work on yesterday evening?" | "Nad czym pracowałem wczoraj wieczorem?" |
| "What's on my left monitor right now?" | "Co jest teraz na moim lewym monitorze?" |
| "Summarize my whole week." | "Podsumuj mi cały tydzień." |

Cursor's agent will pick the right tool (`chronicle_search`, `chronicle_recent`, `chronicle_live_state`, …), call it, read the relevant entries, and reply in the same language you used — citing the source filename.

## Configuration

All optional, set as environment variables (e.g. in `~/.zshrc`/`~/.bashrc`, or in the `env` block of the bundled `mcp.json` if you customize it):

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_CHRONICLE_DIR` | `~/.codex/memories_extensions/chronicle/resources` | Directory containing `*-10min-*.md` (and `*-6h-*.md` if any) files. |
| `CODEX_CHRONICLE_LIVE_DIR` | `$TMPDIR` | Root for Chronicle's ephemeral state — expects `<dir>/codex_chronicle/chronicle-started.pid` and `<dir>/chronicle/screen_recording/`. |
| `CODEX_CHRONICLE_BOOTSTRAP_N` | `3` | Default `limit` for `chronicle_recent` and the `sessionStart` hook bootstrap. |
| `CODEX_CHRONICLE_MAX_AGE_HOURS` | `12` | Default `hoursWindow` for `chronicle_recent`. |
| `CODEX_CHRONICLE_MANIFEST_MAX` | `500` | Hard cap on `chronicle_manifest` rows. |

The bundled `mcp.json` and `hooks/hooks.json` use `${CURSOR_PLUGIN_DIR}` so the absolute path resolves correctly wherever the plugin is installed. To override, edit those files in your local install or fork.

## Debugging

### Smoke-test the `sessionStart` hook outside Cursor

```bash
echo '{"hook_event_name":"sessionStart","conversation_id":"test","workspace_roots":["/tmp"]}' \
  | node hooks/session-start.js \
  | jq -r '.additional_context' \
  | head -30
```

You should see the markdown bootstrap (3 recent summaries + manifest header + live state) that the hook emits.

### Smoke-test the MCP server outside Cursor

```bash
( printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  sleep 1 ) | node src/server.js | jq .
```

You should see an `initialize` response followed by a `tools/list` response with five `chronicle_*` tools.

### Try a tool call

```bash
( printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"chronicle_recent","arguments":{"limit":1}}}'
  sleep 1 ) | node src/server.js | jq -r 'select(.id==2) | .result.content[0].text' | head -40
```

### Inside Cursor

Cursor logs MCP server stderr to its developer tools. Open **Help → Toggle Developer Tools** and look for `[cursor-chronicle]` lines. Errors are written to stderr; stdout is reserved for the JSON-RPC framing.

## Limitations

- The MCP server is read-only by design. It cannot modify Chronicle files or restart the recorder.
- 6-hour rollups (`*-6h-*.md`) are picked up automatically alongside `*-10min-*.md` files, but Codex Chronicle only generates them after running for several hours.
- Cursor MCP servers run in stdio mode per workspace by default. If you switch workspaces frequently, the server starts and stops with each session — that is fine, the cost is sub-second.
- Frame JPEGs (`*-display-N-latest.jpg`) are referenced by path; the agent decides whether to read them. Cursor's vision capabilities determine how useful that is.

## See also

- [`claude-chronicle`](https://github.com/wojciechkapala/claude-chronicle) — the Claude Code counterpart, same data source, different host.
- [Cursor plugins docs](https://cursor.com/docs/plugins) — plugin format reference.
- [Cursor hooks docs](https://cursor.com/docs/hooks) — full event list and `sessionStart` `additional_context` schema.
- [Cursor MCP docs](https://cursor.com/docs/context/mcp) — MCP server transport and config.
- [Cursor Rules docs](https://cursor.com/docs/context/rules) — `.mdc` rule format.
- [Codex Chronicle](https://github.com/openai/codex) — the upstream screen-recording memory feature.

## License

MIT
