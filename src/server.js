#!/usr/bin/env node
// cursor-chronicle MCP server.
// Exposes Codex Chronicle's screen-recording memory to Cursor's agent
// over a stdio MCP transport. Tools mirror what the claude-chronicle
// hook script injects on SessionStart and what the /remind skill does.
//
// Configuration (env vars, all optional):
//   CODEX_CHRONICLE_DIR        (default: ~/.codex/memories_extensions/chronicle/resources)
//   CODEX_CHRONICLE_LIVE_DIR   (default: $TMPDIR)
//   CODEX_CHRONICLE_BOOTSTRAP_N (default: 3, used by chronicle_recent)
//   CODEX_CHRONICLE_MAX_AGE_HOURS (default: 12, used by chronicle_recent)
//   CODEX_CHRONICLE_MANIFEST_MAX (default: 500, used by chronicle_manifest)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  DEFAULT_CHRONICLE_DIR,
  listEntries,
  recent,
  manifest,
  search,
  readEntry,
  formatLocalDt,
  formatRelativeAge,
} from "./chronicle.js";
import { chronicleProcessState, liveScreenState, LIVE_PATHS } from "./live-state.js";

const VERSION = "0.1.0";
const PKG_NAME = "cursor-chronicle";

// ---- Defaults pulled from env -----------------------------------------------

const cfg = {
  chronicleDir: process.env.CODEX_CHRONICLE_DIR || DEFAULT_CHRONICLE_DIR,
  bootstrapN: clampInt(process.env.CODEX_CHRONICLE_BOOTSTRAP_N, 3, 1, 50),
  maxAgeHours: clampInt(process.env.CODEX_CHRONICLE_MAX_AGE_HOURS, 12, 1, 24 * 30),
  manifestMax: clampInt(process.env.CODEX_CHRONICLE_MANIFEST_MAX, 500, 1, 5000),
};

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// ---- Helpers ---------------------------------------------------------------

function textContent(text) {
  return { content: [{ type: "text", text }] };
}

function entryMetaLine(e, now) {
  return `- **${formatLocalDt(e.ts)}** (${formatRelativeAge(e.mtime, now)}, ${e.kind}) — \`${e.path}\``;
}

function buildEntryBlock(e, body, now) {
  const ts = formatLocalDt(e.ts);
  const age = formatRelativeAge(e.mtime, now);
  return `### ${ts} (${e.kind}, ${age})\n_path:_ \`${e.path}\`\n\n${body}\n`;
}

// ---- MCP server ------------------------------------------------------------

const server = new McpServer({
  name: PKG_NAME,
  version: VERSION,
});

// chronicle_recent ----------------------------------------------------------
server.registerTool(
  "chronicle_recent",
  {
    title: "Get recent Chronicle activity",
    description:
      "Return the most recent Codex Chronicle 10-min summaries as full markdown content (with the noisy Recording summary / Citations sections stripped). Use at the start of a conversation, or any time you need to know what the user has been doing in the last ~hour.",
    inputSchema: {
      limit: z.number().int().min(1).max(20).default(cfg.bootstrapN).describe(
        "How many of the freshest 10-min summaries to return.",
      ),
      hoursWindow: z.number().int().min(1).max(168).default(cfg.maxAgeHours).describe(
        "Only consider entries written within this many hours.",
      ),
    },
  },
  async ({ limit, hoursWindow }) => {
    const now = Date.now();
    const entries = await recent({
      limit: limit ?? cfg.bootstrapN,
      hours: hoursWindow ?? cfg.maxAgeHours,
      dir: cfg.chronicleDir,
    });
    if (entries.length === 0) {
      return textContent(
        `No Chronicle entries found in \`${cfg.chronicleDir}\` within the last ${hoursWindow ?? cfg.maxAgeHours}h. ` +
          `Either Codex Chronicle is not active, or the user has not used the computer recently.`,
      );
    }
    const blocks = await Promise.all(
      entries.map(async (e) => buildEntryBlock(e, await readEntry(e.path), now)),
    );
    const header =
      `## Recent Codex Chronicle activity\n\n` +
      `${entries.length} 10-min summary entries (newest last). ` +
      `Each block has had its Recording summary and Citations sections stripped.\n`;
    return textContent([header, ...blocks].join("\n---\n\n"));
  },
);

// chronicle_manifest --------------------------------------------------------
server.registerTool(
  "chronicle_manifest",
  {
    title: "List the entire Chronicle archive",
    description:
      "Return a markdown table of every Chronicle entry on disk (timestamp, age, kind, absolute path), newest first. Use this to find an entry by date/time before calling chronicle_read_entry.",
    inputSchema: {
      limit: z.number().int().min(1).max(5000).default(cfg.manifestMax).describe(
        "Cap on the number of rows. Most recent entries are kept.",
      ),
    },
  },
  async ({ limit }) => {
    const now = Date.now();
    const items = await manifest({
      limit: limit ?? cfg.manifestMax,
      dir: cfg.chronicleDir,
    });
    if (items.length === 0) {
      return textContent(
        `Chronicle archive at \`${cfg.chronicleDir}\` is empty or missing.`,
      );
    }
    const oldest = items[items.length - 1];
    const newest = items[0];
    const head =
      `## Chronicle archive\n\n` +
      `${items.length} entries on disk. Range: **${formatLocalDt(oldest.ts)}** → **${formatLocalDt(newest.ts)}**.\n` +
      `Directory: \`${cfg.chronicleDir}\`\n\n` +
      `| Timestamp (local) | Age | Kind | File |\n|---|---|---|---|`;
    const rows = items.map(
      (e) =>
        `| ${formatLocalDt(e.ts)} | ${formatRelativeAge(e.mtime, now)} | ${e.kind} | \`${e.path}\` |`,
    );
    return textContent([head, ...rows].join("\n"));
  },
);

// chronicle_read_entry ------------------------------------------------------
server.registerTool(
  "chronicle_read_entry",
  {
    title: "Read a specific Chronicle entry",
    description:
      "Read a single Chronicle markdown file by absolute path and return its useful portion (Memory summary + non-obvious context; Recording summary and Citations stripped by default).",
    inputSchema: {
      path: z.string().describe("Absolute path to the *.md file (e.g. as returned by chronicle_manifest)."),
      keepNoisySections: z.boolean().default(false).describe(
        "If true, return the raw file with Recording summary and Citations included.",
      ),
    },
  },
  async ({ path: filePath, keepNoisySections }) => {
    if (!filePath.startsWith(cfg.chronicleDir)) {
      return textContent(
        `Refused to read \`${filePath}\`: path is outside the configured Chronicle directory \`${cfg.chronicleDir}\`.`,
      );
    }
    const text = await readEntry(filePath, { strip: !keepNoisySections });
    return textContent(text);
  },
);

// chronicle_search ----------------------------------------------------------
server.registerTool(
  "chronicle_search",
  {
    title: "Search the Chronicle archive",
    description:
      "Search the Chronicle archive by free-text query and/or time window. Use when the user asks about a topic ('the auth bug', 'projekt logo w Figmie') or a time ('5 hours ago', 'wczoraj wieczorem'), or both. Returns matching entries newest first; call chronicle_read_entry to get the body.",
    inputSchema: {
      query: z.string().optional().describe(
        "Free-text keywords (multiple words = OR semantics, case-insensitive). Omit for time-only search.",
      ),
      sinceHoursAgo: z.number().int().min(0).max(24 * 365).optional().describe(
        "Only return entries with timestamp >= now - this many hours.",
      ),
      untilHoursAgo: z.number().int().min(0).max(24 * 365).optional().describe(
        "Only return entries with timestamp <= now - this many hours.",
      ),
      limit: z.number().int().min(1).max(50).default(15),
    },
  },
  async ({ query, sinceHoursAgo, untilHoursAgo, limit }) => {
    const now = Date.now();
    let results;
    if (query && query.trim()) {
      results = await search({
        query: query.trim(),
        dir: cfg.chronicleDir,
        ocrDir: LIVE_PATHS.RECORDINGS_DIR,
        limit: 200,
      });
    } else {
      results = await listEntries(cfg.chronicleDir);
      results.sort((a, b) => b.mtime - a.mtime);
    }

    if (sinceHoursAgo != null) {
      const since = now - sinceHoursAgo * 3600 * 1000;
      results = results.filter((e) => e.ts >= since);
    }
    if (untilHoursAgo != null) {
      const until = now - untilHoursAgo * 3600 * 1000;
      results = results.filter((e) => e.ts <= until);
    }

    results = results.slice(0, limit ?? 15);

    if (results.length === 0) {
      return textContent(
        `No Chronicle entries matched. Query: ${query ? `\`${query}\`` : "(none)"}, ` +
          `since: ${sinceHoursAgo ?? "n/a"}h ago, until: ${untilHoursAgo ?? "n/a"}h ago.`,
      );
    }

    const head =
      `## Chronicle search results (${results.length})\n` +
      (query ? `Query: \`${query}\`\n` : "") +
      `Newest first. Use **chronicle_read_entry** with the path to read the body.\n`;
    const rows = results.map((e) => entryMetaLine(e, now));
    return textContent([head, ...rows].join("\n"));
  },
);

// chronicle_live_state ------------------------------------------------------
server.registerTool(
  "chronicle_live_state",
  {
    title: "Inspect Codex Chronicle live state",
    description:
      "Report whether the Chronicle recorder process is running, list the freshest screen frame per display (path + age), and surface the OCR sidecar / 1-min historical frames locations. Use to answer 'what is on my screen right now?' or to verify whether Chronicle data is actually fresh.",
    inputSchema: {},
  },
  async () => {
    const now = Date.now();
    const proc = await chronicleProcessState();
    const live = await liveScreenState();

    const lines = ["## Chronicle live state\n"];
    if (proc.kind === "running") {
      lines.push(`- Process: **running** (pid \`${proc.pid}\`) — recordings are fresh.`);
    } else if (proc.kind === "stale") {
      lines.push(
        `- Process: **not running** (stale pidfile, was pid \`${proc.pid}\`) — anything below may be historical, not live.`,
      );
    } else {
      lines.push(`- Process: **not running** (no pidfile) — recordings/summaries may be stale.`);
    }

    if (live.displays.length > 0) {
      lines.push("- Latest screen frames (overwritten on every capture; copy before editing):");
      for (const d of live.displays) {
        lines.push(`  - Display ${d.id}: \`${d.path}\` (${formatRelativeAge(d.mtime, now)})`);
      }
    } else {
      lines.push("- Latest screen frames: none found.");
    }
    if (live.ocrCount > 0) {
      lines.push(`- OCR text history: ${live.ocrCount} \`*.ocr.jsonl\` files in \`${live.recordingsDir}\``);
    }
    if (live.hasHistorical) {
      lines.push(`- Historical 1-minute frame buckets: \`${live.recordingsDir}/1min/\``);
    }

    lines.push("");
    lines.push("### How to pick the right source for a question");
    lines.push(
      `1. **"What is on my screen right now?"** → read the relevant Display N \`latest.jpg\` above. Copy it (\`cp $orig /tmp/snapshot.jpg\`) before editing — the recorder silently overwrites it.`,
    );
    lines.push(
      `2. **"Find the error/text I saw earlier"** → \`rg <term>\` over \`${live.recordingsDir}/*.ocr.jsonl\` to locate the timestamp, then inspect the matching frame in \`1min/<segment>/frame-*.jpg\`.`,
    );
    lines.push(
      `3. **"What was I doing N hours ago?"** → call **chronicle_search** with \`sinceHoursAgo\` / \`untilHoursAgo\`, or **chronicle_manifest** to scan timestamps.`,
    );
    lines.push(
      `4. **OCR is noisy** — only use it for keyword search. When you need the actual text, OCR yourself from the JPG.`,
    );
    lines.push(
      `5. **Upgrade to authoritative sources fast.** Once you have a doc/PR/file/ID from the screen, switch to the corresponding integration or the file system. Don't try to reconstruct an entire document from frames.`,
    );

    return textContent(lines.join("\n"));
  },
);

// ---- Boot ------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stay alive; the SDK handles shutdown via stdin EOF.
}

main().catch((err) => {
  // Errors must go to stderr to avoid corrupting the stdio MCP frame on stdout.
  console.error(`[${PKG_NAME}] fatal:`, err);
  process.exit(1);
});
