#!/usr/bin/env node
// cursor-chronicle / hooks / session-start.js
//
// Cursor sessionStart hook. Builds the same bootstrap payload that the
// claude-chronicle plugin injects via its SessionStart hook (3 freshest
// 10-min summaries in full + manifest of every entry on disk + Chronicle
// live state) and returns it through Cursor's `additional_context` channel.
//
// Cursor passes a JSON envelope on stdin and expects JSON on stdout. We
// ignore the envelope (none of its fields are needed for the bootstrap)
// and stream errors to stderr to avoid corrupting the JSON-RPC frame.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CHRONICLE_DIR,
  recent,
  manifest,
  readEntry,
  formatLocalDt,
  formatRelativeAge,
} from "../src/chronicle.js";
import { chronicleProcessState, liveScreenState } from "../src/live-state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CFG = {
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

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function emitEmpty() {
  // No additional_context → Cursor proceeds normally.
  emit({ additional_context: "", env: {} });
}

async function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    if (process.stdin.isTTY) return resolve(buf);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (buf += chunk));
    process.stdin.on("end", () => resolve(buf));
    // Don't block forever if Cursor closes stdin without writing.
    setTimeout(() => resolve(buf), 250).unref?.();
  });
}

async function buildBootstrap() {
  const now = Date.now();

  // 1. Recent — 3 freshest 10-min summaries in full content.
  const recentEntries = await recent({
    limit: CFG.bootstrapN,
    hours: CFG.maxAgeHours,
    dir: CFG.chronicleDir,
  });

  if (recentEntries.length === 0) return null; // nothing to inject

  const lines = [];
  lines.push("## Recent activity from Codex Chronicle\n");
  lines.push(
    "The following are the most recent 10-minute summaries of what the user has been doing on their computer (passive screen recording analyzed by Codex Chronicle). Use this for current-context awareness, and consult the **Chronicle archive** at the end of this message for older entries.\n",
  );
  for (const e of recentEntries) {
    const body = await readEntry(e.path);
    const ts = formatLocalDt(e.ts);
    const age = formatRelativeAge(e.mtime, now);
    lines.push(`### Chronicle entry: ${ts} (${e.kind}, ${age})`);
    lines.push("");
    lines.push(body);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  // 2. Manifest — every entry on disk, newest first.
  const manifestItems = await manifest({
    limit: CFG.manifestMax,
    dir: CFG.chronicleDir,
  });
  if (manifestItems.length > 0) {
    const oldest = manifestItems[manifestItems.length - 1];
    const newest = manifestItems[0];
    lines.push("## Chronicle archive (older entries available on demand)\n");
    lines.push(`${manifestItems.length} entries on disk.`);
    lines.push(
      `Range: **${formatLocalDt(oldest.ts)}** → **${formatLocalDt(newest.ts)}**.`,
    );
    lines.push(`Directory: \`${CFG.chronicleDir}\`\n`);
    lines.push(
      `To answer questions about earlier activity in any language — e.g. EN: "5 hours ago" / "yesterday evening" / "last week", PL: "5 godzin temu" / "wczoraj wieczorem" / "tydzień temu" — pick the most relevant row(s) from the table below by \`Timestamp\` / \`Age\` and use the \`Read\` tool with the absolute path shown in \`File\`. The \`cursor-chronicle\` MCP server (if registered) also provides \`chronicle_search\` and \`chronicle_read_entry\` tools that wrap this for you.\n`,
    );
    lines.push("| Timestamp (local) | Age | Kind | File |");
    lines.push("|---|---|---|---|");
    for (const e of manifestItems) {
      lines.push(
        `| ${formatLocalDt(e.ts)} | ${formatRelativeAge(e.mtime, now)} | ${e.kind} | \`${e.path}\` |`,
      );
    }
    lines.push("");
  }

  // 3. Live state — pidfile + freshest screen frame per display.
  const proc = await chronicleProcessState();
  const live = await liveScreenState();
  lines.push("## Chronicle live state\n");
  if (proc.kind === "running") {
    lines.push(
      `- Process: **running** (pid \`${proc.pid}\`) — recordings and summaries above are fresh.`,
    );
  } else if (proc.kind === "stale") {
    lines.push(
      `- Process: **not running** (stale pidfile, was pid \`${proc.pid}\`) — recordings and summaries may be stale; treat them as historical, not live.`,
    );
  } else {
    lines.push(
      "- Process: **not running** (no pidfile) — recordings and summaries may be stale; treat them as historical, not live.",
    );
  }
  if (live.displays.length > 0) {
    lines.push(
      "- Latest screen frames (overwritten on every capture; copy to a temp file before editing):",
    );
    for (const d of live.displays) {
      lines.push(
        `  - Display ${d.id}: \`${d.path}\` (${formatRelativeAge(d.mtime, now)})`,
      );
    }
  }
  if (live.ocrCount > 0) {
    lines.push(
      `- OCR text history: ${live.ocrCount} \`*.ocr.jsonl\` files in \`${live.recordingsDir}\``,
    );
  }
  if (live.hasHistorical) {
    lines.push(
      `- Historical 1-minute frame buckets: \`${live.recordingsDir}/1min/\``,
    );
  }
  lines.push("");
  lines.push("### How to pick the right source for a question\n");
  lines.push(
    '1. **"What is on my screen right now?"** → `Read` the relevant `Display N: latest.jpg` above. Note: the file is silently overwritten by the recorder, so copy it (`cp $orig /tmp/snapshot.jpg`) before doing anything else with it.',
  );
  lines.push(
    '2. **"Find the error/text I saw earlier"** → `rg <term>` over `*.ocr.jsonl` in the recordings dir to locate the timestamp, then inspect the matching frame from `1min/<segment>/frame-*.jpg`.',
  );
  lines.push(
    '3. **"What was I doing N hours/days ago?"** → use the **Chronicle archive** table above; pick the row whose `Timestamp`/`Age` matches and `Read` the file path. Or call the `chronicle_search` MCP tool.',
  );
  lines.push(
    "4. **OCR is noisy** — only use it for `rg`-style keyword search. When you need the actual text, OCR yourself from the JPG (do not trust the OCR sidecar text verbatim).",
  );
  lines.push(
    "5. **Upgrade to authoritative sources as soon as possible.** Once you have a doc/PR/file/ID from the screen, switch to the corresponding integration or the file system. Do not try to reconstruct an entire document from frames.",
  );

  return lines.join("\n");
}

async function main() {
  await readStdin(); // drain stdin to be polite; we don't use the envelope
  try {
    const body = await buildBootstrap();
    if (!body) {
      emitEmpty();
      return;
    }
    emit({ additional_context: body, env: {} });
  } catch (err) {
    process.stderr.write(`[cursor-chronicle/sessionStart] ${err.stack || err.message}\n`);
    emitEmpty();
  }
}

main();
