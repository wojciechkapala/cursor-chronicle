// live-state.js — pidfile health + freshest screen frames per display + OCR
// sidecar metadata. Mirrors the "Chronicle live state" section that
// claude-chronicle injects on SessionStart.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const TMPDIR = process.env.CODEX_CHRONICLE_LIVE_DIR || process.env.TMPDIR || os.tmpdir();
const PIDFILE = path.join(TMPDIR, "codex_chronicle", "chronicle-started.pid");
const RECORDINGS_DIR = path.join(TMPDIR, "chronicle", "screen_recording");

export const LIVE_PATHS = { TMPDIR, PIDFILE, RECORDINGS_DIR };

export async function chronicleProcessState() {
  let pidText;
  try {
    pidText = (await fs.readFile(PIDFILE, "utf8")).trim();
  } catch (err) {
    if (err.code === "ENOENT") return { kind: "off" };
    return { kind: "off", error: err.message };
  }
  if (!pidText) return { kind: "off" };
  const pid = Number.parseInt(pidText, 10);
  if (!Number.isFinite(pid)) return { kind: "off" };

  // kill(pid, 0) throws if the process doesn't exist; doesn't actually signal.
  try {
    process.kill(pid, 0);
    return { kind: "running", pid };
  } catch (err) {
    if (err.code === "ESRCH") return { kind: "stale", pid };
    if (err.code === "EPERM") {
      // Process exists but we can't signal it — still alive for our purposes.
      return { kind: "running", pid };
    }
    return { kind: "stale", pid, error: err.message };
  }
}

/**
 * Return the freshest *-display-N-latest.jpg per display id, plus OCR sidecar
 * counts. Returns an empty result if the recordings dir doesn't exist.
 */
export async function liveScreenState() {
  let names;
  try {
    names = await fs.readdir(RECORDINGS_DIR);
  } catch (err) {
    if (err.code === "ENOENT") return { recordingsDir: RECORDINGS_DIR, displays: [], ocrCount: 0, hasHistorical: false };
    throw err;
  }

  const latestByDisplay = new Map(); // displayId -> { path, mtime }
  let ocrCount = 0;

  for (const name of names) {
    if (name.endsWith(".ocr.jsonl")) {
      ocrCount += 1;
      continue;
    }
    const m = name.match(/-display-(\d+)-latest\.jpg$/);
    if (!m) continue;
    const id = m[1];
    const full = path.join(RECORDINGS_DIR, name);
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    const prev = latestByDisplay.get(id);
    if (!prev || stat.mtimeMs > prev.mtime) {
      latestByDisplay.set(id, { path: full, mtime: stat.mtimeMs });
    }
  }

  const hasHistorical = await fs
    .stat(path.join(RECORDINGS_DIR, "1min"))
    .then((s) => s.isDirectory())
    .catch(() => false);

  const displays = Array.from(latestByDisplay.entries())
    .map(([id, v]) => ({ id, path: v.path, mtime: v.mtime }))
    .sort((a, b) => Number(a.id) - Number(b.id));

  return { recordingsDir: RECORDINGS_DIR, displays, ocrCount, hasHistorical };
}
