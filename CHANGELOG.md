# Changelog

All notable changes to **cursor-chronicle** are recorded here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-04-25

### Changed (BREAKING for installation, not for behaviour)
- **Repository is now a proper Cursor plugin** per [cursor.com/docs/plugins](https://cursor.com/docs/plugins). Manifest moved to `.cursor-plugin/plugin.json`; rule moved from `.cursor/rules/cursor-chronicle.mdc` → `rules/cursor-chronicle.mdc`; hook config moved from `.cursor/hooks.json` → `hooks/hooks.json`; an MCP autoloader `mcp.json` is now committed at the repo root. Cursor auto-discovers all four when the plugin loads.
- **One-line install**: clone the repo straight into `~/.cursor/plugins/local/cursor-chronicle`, run `npm install`, restart Cursor. No more hand-editing `~/.cursor/hooks.json` or `~/.cursor/mcp.json` — the bundled `hooks/hooks.json` and `mcp.json` use `${CURSOR_PLUGIN_DIR}` so paths resolve regardless of where the plugin lives.
- README rewritten around the plugin install flow; the manual `mcp.json` / `hooks.json` snippets removed.

### Added
- `.cursor-plugin/marketplace.json` — single-plugin marketplace manifest, pre-populated with `category: context`, tags, homepage, repository, license. Ready for submission to the Cursor marketplace at [cursor.com/marketplace/publish](https://cursor.com/marketplace/publish).
- README links to the relevant Cursor docs (plugins, hooks, MCP, rules).

### Bumped
- `package.json` to 0.3.0; `.cursor-plugin/plugin.json` and `.cursor-plugin/marketplace.json` ship the same version.

## [0.2.0] — 2026-04-25

### Added
- **Native Cursor `sessionStart` hook** (`hooks/session-start.js` + `.cursor/hooks.json`). Returns the same bootstrap payload that `claude-chronicle`'s SessionStart hook injects (3 freshest 10-min summaries in full + manifest of every entry + Chronicle live state) via Cursor's `additional_context` channel. The agent now gets full context at session start without having to call any MCP tool first.
- README now documents both the hook (auto-bootstrap) and the MCP server (on-demand recall) install paths, with a smoke-test recipe for the hook.
- Rule updated: tells the agent to prefer the bootstrap when present and fall back to MCP tools for older / specific lookups.

### Fixed
- README incorrectly claimed Cursor has no equivalent of Claude Code's `SessionStart` / `UserPromptSubmit` hooks. It does — see [https://cursor.com/docs/hooks](https://cursor.com/docs/hooks). The architecture section now lists the actual mechanism per concern (hook for bootstrap, MCP for recall, Rule for guidance).

### Bumped
- `package.json` to 0.2.0.

## [0.1.0] — 2026-04-25

### Added
- Initial release. The Cursor counterpart of [`claude-chronicle`](https://github.com/wojciechkapala/claude-chronicle), built on the two primitives Cursor exposes (MCP + Rules) since Cursor has no `SessionStart` / `UserPromptSubmit` hooks.
- **MCP server** (`src/server.js`, stdio transport, Node.js 18+). Five tools that wrap the Codex Chronicle archive on disk:
  - `chronicle_recent` — last N 10-min summaries as full markdown content (Recording summary / Citations stripped). Mirrors `claude-chronicle`'s SessionStart-bootstrap behaviour.
  - `chronicle_manifest` — table of every Chronicle entry (timestamp, age, kind, absolute path), newest first. Mirrors the SessionStart manifest.
  - `chronicle_search` — search by free-text query and/or `sinceHoursAgo` / `untilHoursAgo` window. Auto-classifies into time / topic / hybrid mode at the agent level. Mirrors the `/claude-chronicle:remind` skill.
  - `chronicle_read_entry` — read one Chronicle file by absolute path, with the noisy `## Recording summary` and `## Citations` sections stripped by default.
  - `chronicle_live_state` — pidfile health, freshest `*-display-N-latest.jpg` per display, OCR sidecar count, 1-min historical frames location. Mirrors the SessionStart live-state section.
- **Cursor rule** at `.cursor/rules/cursor-chronicle.mdc` with `alwaysApply: true`. Tells Cursor's agent which tool to reach for given the user's intent (recall by time, by topic, or both — in EN or PL), and when to call them proactively without asking.
- Bilingual examples (EN + PL) throughout the rule and README.
- README with install instructions, a worked example `mcp.json`, debugging recipes (`tools/list` and `tools/call` smoke tests), and a config-via-env-vars table.
- MIT license, npm `bin` entry so the package can also be invoked as `cursor-chronicle` once published.
