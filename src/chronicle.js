// chronicle.js — read & filter Codex Chronicle markdown summaries.
//
// Mirrors what the claude-chronicle hook script does, but exposed as
// regular async functions consumable by an MCP server.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const HOME = os.homedir();
export const DEFAULT_CHRONICLE_DIR =
  process.env.CODEX_CHRONICLE_DIR ||
  path.join(HOME, ".codex/memories_extensions/chronicle/resources");

// --- Filename parsing ----------------------------------------------------

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/;
const KIND_10MIN = "10min";
const KIND_6H = "6h";

/** Parse the leading UTC timestamp out of a Chronicle filename. */
export function parseFilenameTimestamp(filename) {
  const m = filename.match(TS_RE);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  // The chronicle filename clock is UTC.
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function detectKind(filename) {
  if (filename.includes("-10min-")) return KIND_10MIN;
  if (filename.includes("-6h-")) return KIND_6H;
  return "other";
}

// --- Listing & metadata --------------------------------------------------

/**
 * List every Chronicle entry with metadata, sorted ascending by mtime.
 * Returns [{ path, basename, kind, mtime, ts }] where mtime/ts are epoch ms.
 */
export async function listEntries(dir = DEFAULT_CHRONICLE_DIR) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  const matches = names.filter((n) => /-(?:10min|6h)-.*\.md$/.test(n));
  const items = await Promise.all(
    matches.map(async (basename) => {
      const full = path.join(dir, basename);
      const stat = await fs.stat(full);
      return {
        path: full,
        basename,
        kind: detectKind(basename),
        mtime: stat.mtimeMs,
        ts: parseFilenameTimestamp(basename) ?? stat.mtimeMs,
      };
    }),
  );
  items.sort((a, b) => a.mtime - b.mtime);
  return items;
}

// --- Section stripping ---------------------------------------------------

/** Strip "## Recording summary" and "## Citations" blocks (and their bodies). */
export function stripNoisySections(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (/^##\s+Recording summary\s*$/.test(line) || /^##\s+Citations\s*$/.test(line)) {
      skipping = true;
      continue;
    }
    if (/^##\s+/.test(line) && skipping) {
      skipping = false;
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Read a Chronicle entry and return its useful portion. */
export async function readEntry(filePath, { strip = true } = {}) {
  const text = await fs.readFile(filePath, "utf8");
  return strip ? stripNoisySections(text) : text;
}

// --- Recent / manifest helpers -------------------------------------------

/** N most recent 10-min entries within the last `hours`. */
export async function recent({ limit = 3, hours = 12, dir } = {}) {
  const all = await listEntries(dir);
  const cutoff = Date.now() - hours * 3600 * 1000;
  const tenMin = all.filter((e) => e.kind === KIND_10MIN && e.mtime >= cutoff);
  return tenMin.slice(-limit);
}

/** Whole archive, newest first, with optional cap. */
export async function manifest({ limit = 500, dir } = {}) {
  const all = await listEntries(dir);
  return all.slice(-limit).reverse();
}

// --- Search --------------------------------------------------------------

/**
 * Run ripgrep across the archive (and optionally OCR sidecars).
 * Falls back to a JS-side scan if `rg` is not on PATH.
 */
export async function search({
  query,
  caseInsensitive = true,
  dir = DEFAULT_CHRONICLE_DIR,
  ocrDir,
  limit = 20,
}) {
  if (!query) return [];

  const rgAvailable = await commandExists("rg");
  const targets = [dir];
  if (ocrDir) targets.push(ocrDir);

  if (rgAvailable) {
    const args = ["-l", "--no-messages"];
    if (caseInsensitive) args.push("-i");
    // Split on whitespace → multiple -e patterns OR-joined by rg semantics.
    for (const part of query.trim().split(/\s+/)) {
      args.push("-e", part);
    }
    args.push(...targets);

    const matchedFiles = await runCapture("rg", args).catch(() => []);
    if (matchedFiles.length === 0) return [];
    const stats = await Promise.all(
      matchedFiles.map(async (file) => {
        try {
          const stat = await fs.stat(file);
          return {
            path: file,
            basename: path.basename(file),
            kind: detectKind(path.basename(file)),
            mtime: stat.mtimeMs,
            ts: parseFilenameTimestamp(path.basename(file)) ?? stat.mtimeMs,
          };
        } catch {
          return null;
        }
      }),
    );
    return stats
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
  }

  // Fallback: load every file and substring match (slow, but dependency-free).
  const all = await listEntries(dir);
  const needles = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = [];
  for (const e of all) {
    const text = await fs.readFile(e.path, "utf8").catch(() => "");
    const haystack = text.toLowerCase();
    if (needles.some((n) => haystack.includes(n))) hits.push(e);
  }
  return hits.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

// --- Small process helpers -----------------------------------------------

function runCapture(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || code === 1) {
        // rg exits 1 when there are no matches; treat as success with 0 results.
        const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        resolve(lines);
      } else {
        reject(new Error(`${cmd} exited with ${code}`));
      }
    });
  });
}

async function commandExists(cmd) {
  try {
    await runCapture(process.platform === "win32" ? "where" : "which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

// --- Formatting helpers (used by the MCP server response builders) -------

export function formatRelativeAge(epochMs, now = Date.now()) {
  const diff = Math.max(0, Math.floor((now - epochMs) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) {
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`;
  }
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  return h > 0 ? `${d}d ${h}h ago` : `${d}d ago`;
}

export function formatLocalDt(epochMs) {
  const d = new Date(epochMs);
  // Locale-neutral "YYYY-MM-DD HH:MM" with the system timezone abbreviation.
  const pad = (n) => String(n).padStart(2, "0");
  const tz = d.toLocaleTimeString(undefined, { timeZoneName: "short" }).split(" ").pop();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${tz}`;
}
