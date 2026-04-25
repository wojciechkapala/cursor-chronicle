# Changelog

All notable changes to **cursor-chronicle** are recorded here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
