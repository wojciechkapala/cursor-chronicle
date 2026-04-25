# cursor-chronicle

> Bring [Codex Chronicle](https://github.com/openai/codex)'s screen-recording memory into Cursor. Ask Cursor *"what was I doing 5 hours ago?"* or *"when did I last touch the auth bug?"* and get a real answer.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](CHANGELOG.md)
[![Cursor MCP](https://img.shields.io/badge/Cursor-MCP%20server-7C3AED.svg)](https://cursor.com/docs/context/mcp)

Codex Chronicle (an OpenAI Codex feature) passively records your screen, runs OCR, and writes a markdown summary every ~10 minutes describing what you have been doing across your apps. **cursor-chronicle** is a tiny [Model Context Protocol](https://modelcontextprotocol.io) server that exposes those summaries to Cursor's agent as tools, plus a Cursor rule (`.cursor/rules/cursor-chronicle.mdc`) that teaches the agent when to use them.

It is the Cursor counterpart of [`claude-chronicle`](https://github.com/wojciechkapala/claude-chronicle) — same data source, same behaviour, but built on the primitives Cursor actually exposes (MCP + Rules) rather than Claude Code's hooks.

## How it works

Cursor has no equivalent of Claude Code's `SessionStart` / `UserPromptSubmit` hooks, so we use the two primitives Cursor *does* support:

1. **MCP server** (`src/server.js`, stdio transport). Exposes 5 tools that wrap the Chronicle archive on disk:
   - `chronicle_recent` — last N 10-min summaries as full markdown.
   - `chronicle_manifest` — table of every entry (timestamp, age, kind, path).
   - `chronicle_search` — by free-text query and/or time window.
   - `chronicle_read_entry` — full body of one entry, with the noisy `## Recording summary` and `## Citations` sections stripped.
   - `chronicle_live_state` — pidfile health, freshest screen frame per display, OCR sidecar locations.
2. **Always-on rule** (`.cursor/rules/cursor-chronicle.mdc` with `alwaysApply: true`). Tells the Cursor agent which tool to reach for given the user's intent (recall by time, by topic, or both — in EN or PL).

Together they reproduce the behaviour of `claude-chronicle`'s `SessionStart` hook, `UserPromptSubmit` delta hook, and `/remind` skill — but pulled on demand by Cursor's agent rather than pushed every session.

## Prerequisites

- macOS or Linux
- Node.js **18+**
- [Codex CLI](https://github.com/openai/codex) installed and Chronicle enabled, writing to `~/.codex/memories_extensions/chronicle/resources/`
- (Optional) `rg` (ripgrep) on `PATH` for fast keyword search; falls back to a JS-side scan if missing

## Install

### 1. Clone & install dependencies

```bash
git clone https://github.com/wojciechkapala/cursor-chronicle.git
cd cursor-chronicle
npm install
```

### 2. Register the MCP server in Cursor

Cursor reads MCP config from either `~/.cursor/mcp.json` (global) or `<workspace>/.cursor/mcp.json` (project). Add an entry:

```json
{
  "mcpServers": {
    "cursor-chronicle": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/cursor-chronicle/src/server.js"]
    }
  }
}
```

Replace `/absolute/path/to/cursor-chronicle` with the directory you cloned into.

Restart Cursor and confirm the server is connected: **Settings → Features → Model Context Protocol** should list `cursor-chronicle` with 5 tools available.

### 3. Use the rule

The `.cursor/rules/cursor-chronicle.mdc` file in this repo is set to `alwaysApply: true`, so Cursor automatically loads it for any workspace where this folder is the project root. To use the same rule across **all** projects, copy it into your global Cursor rules directory or into each workspace's `.cursor/rules/`:

```bash
mkdir -p ~/.cursor/rules
cp .cursor/rules/cursor-chronicle.mdc ~/.cursor/rules/
```

(Cursor's project rules in `<workspace>/.cursor/rules/` override user rules; both are loaded.)

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

All optional, set via environment variables in your `mcp.json` `env` block:

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_CHRONICLE_DIR` | `~/.codex/memories_extensions/chronicle/resources` | Directory containing `*-10min-*.md` (and `*-6h-*.md` if any) files. |
| `CODEX_CHRONICLE_LIVE_DIR` | `$TMPDIR` | Root for Chronicle's ephemeral state — expects `<dir>/codex_chronicle/chronicle-started.pid` and `<dir>/chronicle/screen_recording/`. |
| `CODEX_CHRONICLE_BOOTSTRAP_N` | `3` | Default `limit` for `chronicle_recent`. |
| `CODEX_CHRONICLE_MAX_AGE_HOURS` | `12` | Default `hoursWindow` for `chronicle_recent`. |
| `CODEX_CHRONICLE_MANIFEST_MAX` | `500` | Hard cap on `chronicle_manifest` rows. |

Example `mcp.json` with custom config:

```json
{
  "mcpServers": {
    "cursor-chronicle": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/me/code/cursor-chronicle/src/server.js"],
      "env": {
        "CODEX_CHRONICLE_BOOTSTRAP_N": "5",
        "CODEX_CHRONICLE_MAX_AGE_HOURS": "24"
      }
    }
  }
}
```

## Debugging

### Smoke-test the server outside Cursor

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

- [`claude-chronicle`](https://github.com/wojciechkapala/claude-chronicle) — the Claude Code counterpart, using SessionStart / UserPromptSubmit hooks instead of MCP.
- [Cursor MCP docs](https://cursor.com/docs/context/mcp)
- [Cursor Rules docs](https://cursor.com/docs/context/rules)
- [Codex Chronicle](https://github.com/openai/codex)

## License

MIT
