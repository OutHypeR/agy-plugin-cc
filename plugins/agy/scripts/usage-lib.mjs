// Shared usage file: Antigravity's quota, as agy itself reports it, for the companion's quota guard and /agy:setup.
//
// Antigravity's numbers come from agy itself: agy runs its documented statusLine command
// (agy-statusline.mjs) with a `quota` object on every state change, in headless runs too.
// Nothing here reads either tool's sign-in files or calls their servers directly.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IS_WIN = process.platform === "win32";
export const HOME = process.env.AGY_COMPANION_HOME || path.join(os.homedir(), ".claude", "agy-companion");
export const USAGE_FILE = path.join(HOME, "usage.json");
export const BIN_DIR = path.join(HOME, "bin");
export const AGY_SETTINGS = path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHARED = ["usage-lib.mjs", "agy-statusline.mjs"];

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

export function readUsage() {
  return readJson(USAGE_FILE, {}) || {};
}

export function writeSection(name, data) {
  const u = readUsage();
  u[name] = data;
  writeJsonAtomic(USAGE_FILE, u);
}

// ---------- installing the stable copies and agy's statusLine ----------

// The plugin's cache folder changes with every version, so agy's settings and the mod point
// at copies in ~/.claude/agy-companion/bin, refreshed whenever they differ.
export function installBin() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  for (const f of SHARED) {
    const src = path.join(HERE, f);
    const dst = path.join(BIN_DIR, f);
    try {
      const a = fs.readFileSync(src, "utf8");
      let b = null;
      try {
        b = fs.readFileSync(dst, "utf8");
      } catch {}
      if (a !== b) fs.writeFileSync(dst, a);
    } catch {}
  }
}

export function statuslineCommand() {
  // agy hands quotes to the program literally (agy 1.3.2 on Windows), so the path goes unquoted.
  const p = path.join(BIN_DIR, "agy-statusline.mjs").replace(/\\/g, "/");
  return p.includes(" ") ? `node "${p}"` : `node ${p}`;
}

// Adds our statusLine to agy's settings. Never replaces someone else's statusLine.
export function ensureAgyStatusline() {
  installBin();
  let settings = {};
  if (fs.existsSync(AGY_SETTINGS)) {
    settings = readJson(AGY_SETTINGS, null);
    if (!settings) return { ok: false, reason: `could not parse ${AGY_SETTINGS}; left it alone` };
  }
  const want = { type: "command", command: statuslineCommand(), stack_with_default: true };
  const cur = settings.statusLine;
  if (cur && cur.command === want.command && cur.stack_with_default === true) return { ok: true, changed: false };
  // Replace only our own entry, or one whose script no longer exists; never another tool's.
  const curCmd = String((cur && cur.command) || "");
  const target = curCmd.replace(/^node\s+/, "").replace(/^"|"$/g, "");
  const ours = curCmd.includes(BIN_DIR.replace(/\\/g, "/")) || curCmd.includes(BIN_DIR);
  if (cur && !ours && fs.existsSync(target)) {
    return { ok: false, reason: `agy already has a statusLine (${curCmd}); left it alone` };
  }
  settings.statusLine = { ...(cur || {}), ...want };
  writeJsonAtomic(AGY_SETTINGS, settings);
  return { ok: true, changed: true };
}

// ---------- reading the numbers ----------

const minBucket = (buckets, names) => {
  let best = null;
  for (const n of names) {
    const b = buckets?.[n];
    if (!b || typeof b.remaining_fraction !== "number") continue;
    if (!best || b.remaining_fraction < best.remaining) {
      best = { remaining: b.remaining_fraction, resetAt: b.reset_time ? Date.parse(b.reset_time) : null, bucket: n };
    }
  }
  return best;
};

// One figure per lane: the tightest of its windows (5-hour and weekly), as a remaining fraction.
export function lanes(usage = readUsage(), now = Date.now()) {
  const out = {};
  const a = usage.antigravity;
  if (a && a.buckets) {
    const age = now - (a.at || 0);
    const claude = minBucket(a.buckets, Object.keys(a.buckets).filter((k) => k.startsWith("3p-")));
    const gemini = minBucket(a.buckets, Object.keys(a.buckets).filter((k) => k.startsWith("gemini-")));
    if (claude) out.agyClaude = { ...claude, age, plan: a.plan };
    if (gemini) out.agyGemini = { ...gemini, age, plan: a.plan };
  }
  return out;
}
