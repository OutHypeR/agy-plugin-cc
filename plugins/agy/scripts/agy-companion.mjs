#!/usr/bin/env node
// agy-companion: runs Google's official Antigravity CLI (`agy`) for Claude Code.
//
// It only ever starts the unmodified `agy` binary under the user's own sign-in.
// It never reads, copies or forwards agy's credentials and never calls Google's
// servers itself (see README "Why it is built this way").

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureAgyStatusline, lanes } from "./usage-lib.mjs";

const SELF = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(SELF), "..");
const IS_WIN = process.platform === "win32";
const STATE_DIR =
  process.env.AGY_COMPANION_HOME || path.join(os.homedir(), ".claude", "agy-companion");
const JOBS_DIR = path.join(STATE_DIR, "jobs");
const MAX_DIFF_BYTES = 400_000;

// ---------- small helpers ----------

function die(msg, code = 1) {
  process.stderr.write(`agy-companion: ${msg}\n`);
  process.exit(code);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...opts });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "", error: r.error };
}

function git(args, cwd) {
  return run("git", args, { cwd });
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function readStdin() {
  if (process.stdin.isTTY) return "";
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function parseArgs(argv, spec) {
  // spec: { flags: Set, values: Set }
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const [name, inline] = a.slice(2).split(/=(.*)/s, 2);
      if (spec.flags.has(name)) {
        opts[name] = true;
        continue;
      }
      if (spec.values.has(name)) {
        const v = inline !== undefined ? inline : argv[++i];
        if (v === undefined) die(`--${name} needs a value`);
        opts[name] = v;
        continue;
      }
    }
    rest.push(a);
  }
  return { opts, rest };
}

function fmtSeconds(s) {
  if (s == null) return "?";
  return s < 90 ? `${s.toFixed(1)} s` : `${(s / 60).toFixed(1)} min`;
}

function newJobId() {
  const t = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `agy-${t}-${Math.random().toString(36).slice(2, 6)}`;
}

function jobDir(id) {
  return path.join(JOBS_DIR, id);
}

function loadJob(id) {
  return readJson(path.join(jobDir(id), "job.json"));
}

function saveJob(job) {
  writeJson(path.join(jobDir(job.id), "job.json"), job);
}

function listJobs() {
  if (!fs.existsSync(JOBS_DIR)) return [];
  return fs
    .readdirSync(JOBS_DIR)
    .map((id) => loadJob(id))
    .filter(Boolean)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function refreshJob(job) {
  // A job whose worker died without writing a final state is marked lost.
  if (job && (job.status === "running" || job.status === "queued") && job.workerPid && !pidAlive(job.workerPid)) {
    const fresh = loadJob(job.id);
    if (fresh && (fresh.status === "running" || fresh.status === "queued")) {
      fresh.status = "failed";
      fresh.error = fresh.error || "The background worker stopped without finishing.";
      fresh.finishedAt = new Date().toISOString();
      saveJob(fresh);
      return fresh;
    }
    return fresh;
  }
  return job;
}

// ---------- finding agy ----------

function findAgy() {
  if (process.env.AGY_BIN && fs.existsSync(process.env.AGY_BIN)) return process.env.AGY_BIN;
  const candidates = [];
  if (IS_WIN) {
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe"));
  } else {
    candidates.push(path.join(os.homedir(), ".local", "bin", "agy"));
  }
  const which = run(IS_WIN ? "where" : "which", ["agy"]);
  if (which.code === 0) {
    for (const line of which.out.split(/\r?\n/)) {
      const p = line.trim();
      if (p && (!IS_WIN || /\.exe$/i.test(p))) candidates.push(p);
    }
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// ---------- git helpers ----------

function gitRoot(cwd) {
  const r = git(["rev-parse", "--show-toplevel"], cwd);
  return r.code === 0 ? path.resolve(r.out.trim()) : null;
}

function gitStatusMap(root) {
  // Map of path -> porcelain status, used to report what agy changed.
  if (!root) return null;
  const r = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root);
  if (r.code !== 0) return null;
  const map = new Map();
  const parts = r.out.split("\0").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const st = entry.slice(0, 2);
    const file = entry.slice(3);
    map.set(file, st);
    if (st.startsWith("R") || st.startsWith("C")) i++; // skip rename source
  }
  return map;
}

function fileHashes(root, files) {
  const out = new Map();
  for (const f of files) {
    try {
      const st = fs.statSync(path.join(root, f));
      out.set(f, `${st.size}:${st.mtimeMs}`);
    } catch {
      out.set(f, "missing");
    }
  }
  return out;
}

// ---------- read-only snapshots ----------

function makeSnapshot(root, id) {
  const snap = path.join(os.tmpdir(), `agy-snapshot-${id}`);
  const add = git(["worktree", "add", "--detach", "--quiet", snap, "HEAD"], root);
  if (add.code !== 0) die(`could not make a read-only snapshot: ${add.err.trim()}`);
  // Carry over uncommitted tracked changes.
  const diff = git(["diff", "HEAD", "--binary"], root);
  if (diff.code === 0 && diff.out.trim()) {
    const ap = run("git", ["apply", "--whitespace=nowarn", "-"], { cwd: snap, input: diff.out });
    if (ap.code !== 0) process.stderr.write(`agy-companion: some uncommitted changes did not copy into the snapshot: ${ap.err.trim()}\n`);
  }
  // Carry over untracked (not ignored) files.
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"], root);
  if (untracked.code === 0) {
    for (const f of untracked.out.split("\0").filter(Boolean)) {
      try {
        fs.mkdirSync(path.dirname(path.join(snap, f)), { recursive: true });
        fs.copyFileSync(path.join(root, f), path.join(snap, f));
      } catch {
        /* unreadable file: skip */
      }
    }
  }
  return snap;
}

function removeSnapshot(root, snap) {
  if (!snap) return;
  git(["worktree", "remove", "--force", snap], root);
  if (fs.existsSync(snap)) fs.rmSync(snap, { recursive: true, force: true });
  git(["worktree", "prune"], root);
}

// ---------- running agy ----------

function agyArgs(job) {
  const args = ["--input-format", "stream-json", "--output-format", "stream-json"];
  if (job.model) args.push("--model", job.model);
  if (job.conversation) args.push("--conversation", job.conversation);
  if (job.allowShell) args.push("--dangerously-skip-permissions");
  return args;
}

function runAgy(job, { echo = false } = {}) {
  // Runs agy for one job and fills in its result fields. Resolves with the job.
  return new Promise((resolve) => {
    const dir = jobDir(job.id);
    const eventsFile = path.join(dir, "events.ndjson");
    const stderrFile = path.join(dir, "stderr.txt");
    const events = fs.createWriteStream(eventsFile);
    const errs = fs.createWriteStream(stderrFile);

    const child = spawn(job.agyPath, agyArgs(job), {
      cwd: job.runCwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    job.agyPid = child.pid;
    job.status = "running";
    job.startedAt = new Date().toISOString();
    saveJob(job);

    let buf = "";
    let result = null;
    let lastStep = null;
    child.stdout.on("data", (chunk) => {
      events.write(chunk);
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.event === "init" && ev.conversation_id) {
          job.conversationId = ev.conversation_id;
          job.model = job.model || ev.init?.model || null;
          saveJob(job);
        } else if (ev.event === "step_update") {
          const s = ev.step_update || ev;
          if (s.step_type === "tool" && s.state === "DONE") lastStep = s.tool_name;
          if (echo && s.step_type === "tool" && s.state === "DONE") process.stderr.write(`  agy: ${s.tool_name}\n`);
        } else if (ev.event === "result") {
          result = ev.result;
        }
      }
    });
    child.stderr.on("data", (chunk) => errs.write(chunk));

    const prompt = fs.readFileSync(path.join(dir, "prompt.txt"), "utf8");
    child.stdin.write(JSON.stringify({ event: "user", message: { content: prompt } }) + "\n");
    child.stdin.end();

    const finish = (code, spawnError) => {
      events.end();
      errs.end();
      const fresh = loadJob(job.id) || job;
      if (fresh.status === "cancelled") return resolve(fresh);
      Object.assign(fresh, {
        exitCode: code,
        finishedAt: new Date().toISOString(),
        lastTool: lastStep,
      });
      if (result) {
        Object.assign(fresh, {
          status: result.status === "SUCCESS" ? "completed" : "failed",
          agyStatus: result.status,
          response: result.response || "",
          conversationId: result.conversation_id || fresh.conversationId,
          durationSeconds: result.duration_seconds,
          usage: result.usage || null,
          deniedActions: result.denied_actions || [],
          error: result.error || null,
        });
      } else {
        let errText = "";
        try {
          errText = fs.readFileSync(stderrFile, "utf8").trim().split(/\r?\n/).slice(-15).join("\n");
        } catch {}
        fresh.status = "failed";
        fresh.error = spawnError ? String(spawnError.message || spawnError) : errText || `agy exited with code ${code} and no result.`;
      }
      saveJob(fresh);
      resolve(fresh);
    };
    child.on("error", (e) => finish(null, e));
    child.on("close", (code) => finish(code));
  });
}

async function executeJob(job, { echo = false } = {}) {
  let snapshot = null;
  try {
    let before = null;
    let beforeHashes = null;
    if (job.mode === "read-only-snapshot") {
      snapshot = makeSnapshot(job.gitRoot, job.id);
      const rel = path.relative(job.gitRoot, job.cwd);
      job.runCwd = path.join(snapshot, rel);
      job.snapshot = snapshot;
      saveJob(job);
    } else if (job.mode === "write" && job.gitRoot) {
      before = gitStatusMap(job.gitRoot);
      beforeHashes = before ? fileHashes(job.gitRoot, [...before.keys()]) : null;
    }

    const done = await (job.backend === "gemini-api" ? runGeminiApi(job, { echo }) : runAgy(job, { echo }));

    if (job.mode === "write" && job.gitRoot && before) {
      const after = gitStatusMap(job.gitRoot);
      if (after) {
        const afterHashes = fileHashes(job.gitRoot, [...after.keys()]);
        const changed = [];
        for (const [f, st] of after) {
          if (!before.has(f) || before.get(f) !== st || beforeHashes.get(f) !== afterHashes.get(f)) changed.push(f);
        }
        for (const f of before.keys()) if (!after.has(f)) changed.push(f);
        done.changedFiles = changed;
        saveJob(done);
      }
    }
    if (snapshot && done.gitRoot) {
      const snapStatus = gitStatusMap(snapshot);
      const base = gitStatusMap(done.gitRoot);
      const touched = [];
      if (snapStatus) {
        for (const [f, st] of snapStatus) if (!base || base.get(f) !== st) touched.push(f);
      }
      done.snapshotEdits = touched;
      // Point paths in the reply at the real repository, not the copy that is about to be deleted.
      if (done.response) {
        const fwd = (p) => p.replace(/\\/g, "/");
        done.response = done.response.split(snapshot).join(done.gitRoot).split(fwd(snapshot)).join(fwd(done.gitRoot));
      }
      saveJob(done);
    }
    return done;
  } finally {
    if (snapshot) removeSnapshot(job.gitRoot, snapshot);
    if (job.mode === "review" && job.runCwd && job.runCwd.includes("agy-review-")) {
      fs.rmSync(job.runCwd, { recursive: true, force: true });
    }
  }
}

// ---------- Gemini API key backend ----------
//
// Runs Google's open-source Gemini CLI (`gemini -p`) with the user's own GEMINI_API_KEY, so the work is
// billed to their Gemini API key under the Gemini API terms rather than their Antigravity plan. This is
// the route Google's Antigravity FAQ recommends for third-party coding agents. The plugin never reads,
// prints or stores the key; Gemini CLI reads it from the environment (or its own ~/.gemini/.env).

function geminiApiStatus() {
  const which = run(IS_WIN ? "where" : "which", ["gemini"]);
  const settings = readJson(path.join(os.homedir(), ".gemini", "settings.json"), {}) || {};
  const authType = settings?.security?.auth?.selectedType || settings?.selectedAuthType || null;
  const key = Boolean(process.env.GEMINI_API_KEY) || fs.existsSync(path.join(os.homedir(), ".gemini", ".env"));
  return { cli: which.code === 0, key, authType };
}

function checkGeminiApi() {
  const g = geminiApiStatus();
  if (!g.cli) die("--gemini-api needs Gemini CLI: npm install -g @google/gemini-cli");
  if (!g.key) die("--gemini-api needs GEMINI_API_KEY (a key from Google AI Studio) in your environment or in ~/.gemini/.env.");
  if (g.authType && g.authType !== "gemini-api-key")
    die('Gemini CLI is set to a non-API-key sign-in. Set security.auth.selectedType to "gemini-api-key" in ~/.gemini/settings.json first.');
}

function geminiApiModel(name) {
  if (!name) return null;
  if (/^(auto|opus|sonnet|haiku)(-|$)|^claude-/i.test(name)) die("Claude models are not available with a Gemini API key; leave --model out or name a Gemini model.");
  if (name === "gemini-pro" || name === "gemini-flash") die(`"${name}" is an agy shortcut; with --gemini-api name the exact model (see Gemini CLI's /model), or leave --model out.`);
  if (!/^[A-Za-z0-9._-]+$/.test(name)) die(`unexpected model name "${name}"`);
  return name;
}

function runGeminiApi(job, { echo = false } = {}) {
  return new Promise((resolve) => {
    const dir = jobDir(job.id);
    const outFile = path.join(dir, "gemini-output.json");
    const errFile = path.join(dir, "stderr.txt");
    // Read-only work runs in Gemini CLI's own plan (read-only) mode; edits are auto-approved; shell only with --allow-shell.
    const mode = job.mode === "write" ? (job.allowShell ? "yolo" : "auto_edit") : "plan";
    // --skip-trust: Gemini CLI's documented switch for headless and automated runs in a folder not trusted interactively.
    const args = ["-p", "Carry out the task given above.", "-o", "json", "--approval-mode", mode, "--skip-trust"];
    if (job.model) args.push("-m", job.model);
    // gemini is an npm shim on Windows, so it is started through the shell; every argument is fixed or validated above.
    const shellArgs = IS_WIN ? args.map((x) => (/[\s"]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x)) : args;
    const child = spawn("gemini", shellArgs, { cwd: job.runCwd, shell: IS_WIN, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    job.agyPid = child.pid;
    job.status = "running";
    job.startedAt = new Date().toISOString();
    saveJob(job);
    const started = Date.now();
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => {
      err += d;
      if (echo) process.stderr.write(d);
    });
    child.stdin.write(fs.readFileSync(path.join(dir, "prompt.txt"), "utf8"));
    child.stdin.end();
    const finish = (code, spawnError) => {
      try {
        fs.writeFileSync(outFile, out);
        fs.writeFileSync(errFile, err);
      } catch {}
      const fresh = loadJob(job.id) || job;
      if (fresh.status === "cancelled") return resolve(fresh);
      // Gemini CLI prints its JSON result on stdout, and its JSON error on stderr.
      const parseFrom = (text) => {
        // The JSON starts on a line of its own; earlier log lines may contain braces too.
        const m = /^\{/m.exec(text);
        const i = m ? m.index : -1;
        const j = text.lastIndexOf("}");
        if (i < 0 || j < i) return null;
        try {
          return JSON.parse(text.slice(i, j + 1));
        } catch {
          return null;
        }
      };
      const parsed = parseFrom(out) || parseFrom(err);
      // API errors arrive as JSON nested inside strings; keep the innermost readable message.
      if (parsed?.error?.message) {
        const msgs = [...String(parsed.error.message).matchAll(/message\\*"\s*:\s*\\*"((?:[^"\\]|\\[^"])*)/g)]
          .map((m) => m[1].replace(/\\+n/g, " ").trim())
          .filter((m) => m && !m.startsWith("{"));
        if (msgs.length) parsed.error.message = msgs[msgs.length - 1];
      }
      fresh.exitCode = code;
      fresh.finishedAt = new Date().toISOString();
      fresh.durationSeconds = (Date.now() - started) / 1000;
      if (parsed && !parsed.error && typeof parsed.response === "string") {
        fresh.status = "completed";
        fresh.response = parsed.response;
        let total = 0;
        for (const m of Object.values(parsed.stats?.models || {})) total += m?.tokens?.total || 0;
        if (total) fresh.usage = { total_tokens: total };
        if (!fresh.model) fresh.model = Object.keys(parsed.stats?.models || {})[0] || null;
      } else {
        fresh.status = "failed";
        fresh.error =
          parsed?.error?.message ||
          (spawnError ? String(spawnError.message || spawnError) : null) ||
          err.trim().split(/\r?\n/).slice(-8).join("\n") ||
          `gemini exited with code ${code} and no result.`;
      }
      saveJob(fresh);
      resolve(fresh);
    };
    child.on("error", (e) => finish(null, e));
    child.on("close", (code) => finish(code));
  });
}

// ---------- rendering ----------

function render(job) {
  const lines = [];
  if (job.status === "completed" || (job.status === "failed" && job.response)) {
    lines.push((job.response || "").trim() || "(agy returned an empty reply)");
  }
  if (job.status === "failed") {
    lines.push("");
    lines.push(`${job.backend === "gemini-api" ? "Gemini CLI" : "agy"} failed${job.agyStatus ? ` (${job.agyStatus})` : ""}: ${job.error || "no details"}`);
    if (job.backend !== "gemini-api" && /auth/i.test(job.error || "")) lines.push("Sign in once by running `agy` in a terminal, then run /agy:setup.");
  }
  if (job.status === "cancelled") lines.push(`Job ${job.id} was cancelled.`);

  const notes = [];
  if (job.deniedActions && job.deniedActions.length) {
    const names = [...new Set(job.deniedActions.map((d) => d.display_name || d.action))].join(", ");
    notes.push(
      `agy was not allowed to run: ${names}. Shell commands are blocked by default; re-run with --allow-shell to let agy run them.`,
    );
  }
  if (job.changedFiles && job.changedFiles.length) {
    notes.push(`Files changed by agy (${job.changedFiles.length}): ${job.changedFiles.slice(0, 25).join(", ")}${job.changedFiles.length > 25 ? ", ..." : ""}`);
  } else if (job.mode === "write" && job.changedFiles) {
    notes.push("agy did not change any files.");
  }
  if (job.snapshotEdits && job.snapshotEdits.length) {
    notes.push(`Read-only run: agy edited ${job.snapshotEdits.length} file(s) in a throwaway copy; nothing reached your files.`);
  }
  const usage = job.usage ? `${job.usage.total_tokens?.toLocaleString("en-US")} tokens` : null;
  const meta = [
    job.backend === "gemini-api" ? "gemini api key" : "agy",
    job.model,
    job.mode === "write" ? "can edit" : job.mode === "review" ? "review" : "read-only",
    job.durationSeconds != null ? fmtSeconds(job.durationSeconds) : null,
    usage,
    job.conversationId ? `conversation ${job.conversationId}` : null,
    `job ${job.id}`,
  ].filter(Boolean);
  lines.push("");
  for (const n of notes) lines.push(`- ${n}`);
  lines.push(`[${meta.join(" | ")}]`);
  return lines.join("\n");
}

// ---------- models ----------

const CONFIG_FILE = path.join(STATE_DIR, "config.json");
const DEFAULT_MODEL = "auto";
const MODELS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function loadConfig() {
  return readJson(CONFIG_FILE, {}) || {};
}

function saveConfig(cfg) {
  writeJson(CONFIG_FILE, cfg);
}

function fetchModels(agy) {
  const m = run(agy, ["models"], { timeout: 60_000 });
  const models = m.out
    .split(/\r?\n/)
    .map((l) => l.split("\t")[0].trim())
    .filter((l) => l && !/^Fetching/i.test(l));
  return { ok: m.code === 0 && models.length > 0, models, code: m.code, text: (m.err || m.out).trim() };
}

function knownModels(agy, { refresh = false } = {}) {
  const cfg = loadConfig();
  const fresh = cfg.models && cfg.modelsAt && Date.now() - cfg.modelsAt < MODELS_MAX_AGE_MS;
  if (fresh && !refresh) return cfg.models;
  const r = fetchModels(agy);
  if (!r.ok) return cfg.models || [];
  saveConfig({ ...loadConfig(), models: r.models, modelsAt: Date.now() });
  return r.models;
}

function versionKey(slug) {
  return (slug.match(/\d+/g) || []).map(Number);
}

function newerFirst(a, b) {
  const va = versionKey(a);
  const vb = versionKey(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] || 0) - (va[i] || 0);
    if (d) return d;
  }
  return 0;
}

// agy encodes effort in the model slug (claude-opus-5-5-high) and its models only have low/medium/high,
// so Claude Code's effort levels are mapped onto those tiers here and no separate --effort is sent.
const DEFAULT_EFFORT = "medium";
const TIERS = ["low", "medium", "high"];

function effortTier(effort) {
  const e = (effort || loadConfig().defaultEffort || DEFAULT_EFFORT).toLowerCase();
  if (e === "none" || e === "minimal" || e === "low") return "low";
  if (e === "medium") return "medium";
  if (e === "high" || e === "xhigh" || e === "max") return "high";
  die(`unknown effort "${effort}" (use low, medium, high, xhigh or max).`);
}

// "opus", "sonnet", "opus-high"... -> the newest matching Claude slug agy offers, at the tier the
// effort asks for (an explicit tier in the name wins). A full slug keeps its own tier unless an
// effort is given and that variant exists. "agy-default" lets agy choose.
function resolveModel(name, agy, effort) {
  const wanted = (name || loadConfig().defaultModel || DEFAULT_MODEL).trim();
  if (wanted === "agy-default") return null;
  if (wanted === "auto") {
    // Hard work (high effort) goes to Opus, everything else to Sonnet.
    const tier = effortTier(effort);
    return resolveModel(`${tier === "high" ? "opus" : "sonnet"}-${tier}`, agy);
  }
  const pickFrom = (pred) => {
    const sel = (list) => list.filter(pred).sort(newerFirst)[0];
    return sel(knownModels(agy)) || sel(knownModels(agy, { refresh: true }));
  };
  const gem = wanted.match(/^gemini-(pro|flash)(?:-(low|medium|high))?$/i);
  if (gem) {
    // Newest Gemini Pro/Flash; Pro has no medium tier, so fall back to the nearest one it has.
    const kind = gem[1].toLowerCase();
    const want = gem[2] ? gem[2].toLowerCase() : effortTier(effort);
    const order = { low: ["low", "medium", "high"], medium: ["medium", "high", "low"], high: ["high", "medium", "low"] }[want];
    for (const t of order) {
      const found = pickFrom((m) => /^gemini-[\d.]+-/.test(m) && m.includes(`-${kind}-`) && m.endsWith(`-${t}`));
      if (found) return found;
    }
    die(`agy offers no Gemini ${kind} model. Models: ${knownModels(agy).join(", ")}`);
  }
  const alias = wanted.match(/^(opus|sonnet|haiku)(?:-(low|medium|high))?$/i);
  if (alias) {
    const family = alias[1].toLowerCase();
    const tier = alias[2] ? alias[2].toLowerCase() : effortTier(effort);
    const found = pickFrom((m) => m.startsWith(`claude-${family}-`) && m.endsWith(`-${tier}`));
    if (!found) die(`agy offers no Claude ${family} model at "${tier}". Models: ${knownModels(agy).join(", ")}`);
    return found;
  }
  if (!effort) return wanted;
  const tierRe = new RegExp(`-(${TIERS.join("|")})$`);
  const base = wanted.replace(tierRe, "");
  const variant = `${base}-${effortTier(effort)}`;
  return knownModels(agy).includes(variant) || knownModels(agy, { refresh: true }).includes(variant) ? variant : wanted;
}

// ---------- commands ----------

function cmdSetup(argv) {
  const json = argv.includes("--json");
  const dm = argv.indexOf("--default-model");
  const bk = argv.indexOf("--backend");
  if (bk >= 0) {
    const v = argv[bk + 1];
    if (v !== "agy" && v !== "gemini-api") die("--backend takes agy or gemini-api");
    saveConfig({ ...loadConfig(), backend: v });
  }
  const gm = argv.indexOf("--gemini-api-model");
  if (gm >= 0) {
    const v = argv[gm + 1];
    if (!v) die("--gemini-api-model needs a model name, or 'default'");
    const cfg = loadConfig();
    if (v === "default") delete cfg.geminiApiModel;
    else cfg.geminiApiModel = geminiApiModel(v);
    saveConfig(cfg);
  }
  const agy = findAgy();
  const report = { installed: Boolean(agy), path: agy, version: null, signedIn: false, models: [], defaultModel: null, node: process.version, notes: [] };
  if (agy) {
    const v = run(agy, ["--version"]);
    report.version = (v.out || v.err).trim().split(/\r?\n/).pop() || null;
    const m = fetchModels(agy);
    if (m.ok) {
      report.signedIn = true;
      report.models = m.models;
      saveConfig({ ...loadConfig(), models: m.models, modelsAt: Date.now() });
      if (dm >= 0) {
        const value = argv[dm + 1];
        if (!value) die("--default-model needs a value (opus, sonnet, opus-medium, a full slug, or agy-default).");
        const resolved = resolveModel(value, agy);
        if (resolved && !m.models.includes(resolved)) die(`unknown model "${value}". Models: ${m.models.join(", ")}`);
        saveConfig({ ...loadConfig(), defaultModel: value });
      }
      const de = argv.indexOf("--default-effort");
      if (de >= 0) {
        const value = argv[de + 1];
        effortTier(value); // validates
        saveConfig({ ...loadConfig(), defaultEffort: value });
      }
      const d = loadConfig().defaultModel || DEFAULT_MODEL;
      const r = resolveModel(d, agy);
      report.defaultModel = r ? `${d} (${r})` : "agy's own default";
      report.defaultEffort = loadConfig().defaultEffort || DEFAULT_EFFORT;
    } else {
      report.notes.push(`agy could not list models (exit ${m.code}): ${m.text.slice(0, 400)}`);
      report.notes.push("Run `agy` once in a terminal and sign in with your Google account.");
    }
  } else {
    report.notes.push(
      IS_WIN
        ? "Install agy (PowerShell): irm https://antigravity.google/cli/install.ps1 | iex"
        : "Install agy: curl -fsSL https://antigravity.google/cli/install.sh | bash",
    );
  }
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  const out = [];
  out.push(`agy installed: ${report.installed ? `yes (${report.path}, version ${report.version})` : "no"}`);
  if (report.installed) out.push(`signed in: ${report.signedIn ? "yes" : "no"}`);
  if (report.defaultModel) out.push(`default model: ${report.defaultModel}  (change with: --default-model auto|opus|sonnet|<slug>|agy-default)`);
  if (report.defaultEffort) out.push(`default effort when none is chosen: ${report.defaultEffort}  (change with: --default-effort low|medium|high)`);
  if (report.models.length) out.push(`models: ${report.models.join(", ")}`);
  if (report.installed) {
    const st = ensureAgyStatusline();
    out.push(st.ok ? "usage tracking: on (agy's statusLine feeds ~/.claude/agy-companion/usage.json)" : `usage tracking: off - ${st.reason}`);
    const L = lanes();
    const f = (l) => (l ? `${Math.round(l.remaining * 100)}% left` : "not checked yet");
    out.push(`usage: Antigravity Claude models ${f(L.agyClaude)}, Antigravity Gemini ${f(L.agyGemini)}`);
  }
  const g = geminiApiStatus();
  const cfg = loadConfig();
  out.push("");
  out.push(`default backend: ${cfg.backend === "gemini-api" ? "gemini-api (your Gemini API key)" : "agy (your Google AI plan sign-in)"}  (change with: --backend agy|gemini-api; per run: --agy or --gemini-api)`);
  out.push(`Gemini API key option: Gemini CLI ${g.cli ? "installed" : "not installed (npm install -g @google/gemini-cli)"}; GEMINI_API_KEY ${g.key ? "is set" : "is not set"}${g.authType ? `; Gemini CLI auth: ${g.authType}` : ""}`);
  if (g.authType && g.authType !== "gemini-api-key") out.push("  Gemini CLI is set to a non-API-key sign-in; set security.auth.selectedType to \"gemini-api-key\" in ~/.gemini/settings.json so --gemini-api runs bill your API key.");
  if (cfg.geminiApiModel) out.push(`Gemini API model: ${cfg.geminiApiModel}  (change with: --gemini-api-model <name>|default)`);
  for (const n of report.notes) out.push(n);
  process.stdout.write(out.join("\n") + "\n");
}

const TASK_SPEC = {
  flags: new Set(["background", "read-only", "write", "allow-shell", "resume-last", "fresh", "gemini-api", "agy"]),
  values: new Set(["model", "effort", "conversation", "cwd"]),
};

function lastConversationFor(cwd) {
  const root = gitRoot(cwd) || path.resolve(cwd);
  const job = listJobs().find((j) => (j.gitRoot || j.cwd) === root && j.conversationId && j.kind === "task");
  return job ? job.conversationId : null;
}

// Refuses to start a run on a lane whose quota is used up (numbers under 30 min old).
function checkQuota(model) {
  const L = lanes();
  const lane = !model ? null : model.startsWith("claude-") ? L.agyClaude : model.startsWith("gemini-") ? L.agyGemini : null;
  if (!lane || lane.age > 30 * 60000 || lane.remaining >= 0.03) return;
  const reset = lane.resetAt ? new Date(lane.resetAt).toLocaleString() : "later";
  die(
    `Antigravity's ${model.startsWith("claude-") ? "Claude-model" : "Gemini"} quota is used up (${Math.round(lane.remaining * 100)}% left, resets ${reset}). ` +
      (model.startsWith("claude-") ? "Use --model gemini-pro, or --gemini-api with your own API key." : "Use a Claude model, or --gemini-api with your own API key."),
  );
}

function chosenBackend(opts) {
  if (opts["gemini-api"]) return "gemini-api";
  if (opts.agy) return "agy";
  return loadConfig().backend === "gemini-api" ? "gemini-api" : "agy";
}

function buildJob({ kind, opts, prompt, cwd, title }) {
  const backend = chosenBackend(opts);
  const agy = backend === "agy" ? findAgy() : null;
  if (backend === "agy" && !agy) die("agy is not installed. Run /agy:setup, or use --gemini-api with your own API key.");
  if (backend === "gemini-api") checkGeminiApi();
  const root = gitRoot(cwd);
  const id = newJobId();
  let mode;
  if (kind === "review") mode = "review";
  else if (opts["read-only"]) {
    if (!root) die("--read-only needs a git repository (it runs agy in a throwaway git worktree).");
    mode = "read-only-snapshot";
  } else mode = "write";

  let conversation = opts.conversation || null;
  if (backend === "agy" && !conversation && opts["resume-last"] && !opts.fresh) {
    conversation = lastConversationFor(cwd);
    if (!conversation) process.stderr.write("agy-companion: no earlier agy conversation here; starting a new one.\n");
  }

  let model;
  if (backend === "agy") {
    model = resolveModel(opts.model, agy, opts.effort);
    checkQuota(model);
    try {
      ensureAgyStatusline(); // keeps the shared usage file fed by every run
    } catch {}
  } else {
    model = geminiApiModel(opts.model || loadConfig().geminiApiModel || null);
  }

  const job = {
    id,
    kind,
    mode,
    status: "queued",
    createdAt: new Date().toISOString(),
    cwd: path.resolve(cwd),
    gitRoot: root,
    runCwd: path.resolve(cwd),
    backend,
    agyPath: agy,
    model,
    effort: opts.effort || null,
    conversation,
    allowShell: Boolean(opts["allow-shell"]),
    title: (title || prompt).trim().split(/\r?\n/)[0].slice(0, 100),
  };
  fs.mkdirSync(jobDir(id), { recursive: true });
  fs.writeFileSync(path.join(jobDir(id), "prompt.txt"), prompt);
  saveJob(job);
  return job;
}

async function startJob(job, background) {
  if (background) {
    const child = spawn(process.execPath, [SELF, "_worker", job.id], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    job.workerPid = child.pid;
    saveJob(job);
    process.stdout.write(
      `Started agy in the background as job ${job.id}.\nCheck it with /agy:status ${job.id}; get the answer with /agy:result ${job.id}.\n`,
    );
    return;
  }
  job.workerPid = process.pid;
  saveJob(job);
  const done = await executeJob(job, { echo: true });
  process.stdout.write(render(done) + "\n");
  if (done.status !== "completed") process.exitCode = 1;
}

function noShellPreamble() {
  // In headless mode a refused shell command ends agy's turn with no reply, so say up front that there is no shell.
  return [
    "Shell commands are not available in this session: any attempt to run one (git, tests, builds, scripts) is refused and ends your turn.",
    "Use only your file tools (list, search, view, edit, write) and finish the task with them.",
    "",
  ].join("\n");
}

function readOnlyPreamble() {
  return [
    "You are being consulted read-only. Do not create, edit or delete files and do not run commands that change anything;",
    "you are working in a throwaway copy and any edits will be discarded. Investigate and answer in text.",
    "",
  ].join("\n");
}

async function cmdTask(argv) {
  const { opts, rest } = parseArgs(argv, TASK_SPEC);
  let prompt = rest.join(" ").trim();
  if (!prompt) prompt = readStdin().trim();
  if (!prompt) die("no task given (pass it as arguments or on stdin).");
  const title = prompt;
  if (!opts["allow-shell"]) prompt = noShellPreamble() + prompt;
  if (opts["read-only"]) prompt = readOnlyPreamble() + prompt;
  prompt += "\n\nWhen you are done, end with a short summary of what you found or changed.";
  const job = buildJob({ kind: "task", opts, prompt, cwd: opts.cwd || process.cwd(), title });
  await startJob(job, Boolean(opts.background));
}

const REVIEW_SPEC = {
  flags: new Set(["background", "adversarial", "gemini-api", "agy"]),
  values: new Set(["base", "model", "effort", "cwd"]),
};

function collectDiff(root, base) {
  const parts = [];
  if (base) {
    const mb = git(["merge-base", base, "HEAD"], root);
    if (mb.code !== 0) die(`unknown base ref "${base}": ${mb.err.trim()}`);
    const committed = git(["diff", "--no-color", "--find-renames", `${mb.out.trim()}..HEAD`], root);
    if (committed.out.trim()) parts.push(`### Committed changes since ${base}\n\n${committed.out}`);
  }
  const staged = git(["diff", "--no-color", "--find-renames", "--cached"], root);
  if (staged.out.trim()) parts.push(`### Staged changes\n\n${staged.out}`);
  const unstaged = git(["diff", "--no-color", "--find-renames"], root);
  if (unstaged.out.trim()) parts.push(`### Unstaged changes\n\n${unstaged.out}`);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"], root)
    .out.split("\0")
    .filter(Boolean);
  const newFiles = [];
  for (const f of untracked.slice(0, 40)) {
    try {
      const full = path.join(root, f);
      const st = fs.statSync(full);
      if (st.size > 60_000) {
        newFiles.push(`--- new file ${f} (${st.size} bytes, too big to include)`);
        continue;
      }
      const text = fs.readFileSync(full, "utf8");
      if (text.includes("\0")) continue;
      newFiles.push(`--- new file ${f}\n${text}`);
    } catch {}
  }
  if (untracked.length > 40) newFiles.push(`(${untracked.length - 40} more untracked files not shown)`);
  if (newFiles.length) parts.push(`### New untracked files\n\n${newFiles.join("\n\n")}`);
  let diff = parts.join("\n\n");
  let truncated = false;
  if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) {
    diff = diff.slice(0, MAX_DIFF_BYTES);
    truncated = true;
  }
  return { diff, truncated };
}

async function cmdReview(argv) {
  const { opts, rest } = parseArgs(argv, REVIEW_SPEC);
  const cwd = opts.cwd || process.cwd();
  const root = gitRoot(cwd);
  if (!root) die("review needs a git repository.");
  const { diff, truncated } = collectDiff(root, opts.base || null);
  if (!diff.trim()) die(opts.base ? `nothing to review: no changes since ${opts.base}.` : "nothing to review: no uncommitted changes (use --base <ref> to review a branch).");
  const template = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", opts.adversarial ? "adversarial-review.md" : "review.md"), "utf8");
  const focus = rest.join(" ").trim() || readStdin().trim();
  const prompt = template
    .replace("{{REPO}}", path.basename(root))
    .replace("{{SCOPE}}", opts.base ? `changes since ${opts.base}, plus uncommitted work` : "uncommitted work")
    .replace("{{FOCUS}}", focus ? `The user asked you to focus on: ${focus}` : "No extra focus was given.")
    .replace("{{TRUNCATED}}", truncated ? "NOTE: the diff was cut short because it is very large; say which parts you could not see." : "")
    .replace("{{DIFF}}", diff);
  const job = buildJob({ kind: "review", opts, prompt, cwd, title: `${opts.adversarial ? "adversarial review" : "review"} of ${opts.base ? `changes since ${opts.base}` : "uncommitted work"}${focus ? `: ${focus}` : ""}` });
  // Reviews run in an empty folder: agy gets the diff in the prompt and cannot read or write the repo.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "agy-review-"));
  job.runCwd = empty;
  saveJob(job);
  await startJob(job, Boolean(opts.background));
}

function pickJob(id) {
  const jobs = listJobs();
  if (!jobs.length) die("no agy jobs yet.");
  if (!id) return refreshJob(jobs[0]);
  const job = jobs.find((j) => j.id === id || j.id.endsWith(id));
  if (!job) die(`no job matching "${id}".`);
  return refreshJob(job);
}

function cmdStatus(argv) {
  const id = argv.find((a) => !a.startsWith("--"));
  if (id) {
    const j = pickJob(id);
    const lines = [`${j.id}: ${j.status}`, `  task: ${j.title}`, `  mode: ${j.mode}${j.allowShell ? ", shell allowed" : ""}`];
    if (j.startedAt) lines.push(`  started: ${j.startedAt}`);
    if (j.finishedAt) lines.push(`  finished: ${j.finishedAt}`);
    if (j.status === "running") {
      const tools = countTools(j.id);
      lines.push(`  progress: ${tools.count} tool step(s) so far${tools.last ? `, last: ${tools.last}` : ""}`);
    }
    if (j.error) lines.push(`  error: ${j.error}`);
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }
  const jobs = listJobs().slice(0, 10).map(refreshJob);
  if (!jobs.length) {
    process.stdout.write("No agy jobs yet.\n");
    return;
  }
  for (const j of jobs) process.stdout.write(`${j.id}  ${j.status.padEnd(9)}  ${j.kind.padEnd(6)}  ${j.title}\n`);
}

function countTools(id) {
  let count = 0;
  let last = null;
  try {
    for (const line of fs.readFileSync(path.join(jobDir(id), "events.ndjson"), "utf8").split("\n")) {
      if (!line.includes('"tool"')) continue;
      try {
        const ev = JSON.parse(line);
        const s = ev.step_update || ev;
        if (s.step_type === "tool" && s.state === "DONE") {
          count++;
          last = s.tool_name;
        }
      } catch {}
    }
  } catch {}
  return { count, last };
}

function cmdResult(argv) {
  const id = argv.find((a) => !a.startsWith("--"));
  const j = pickJob(id);
  if (j.status === "running" || j.status === "queued") {
    process.stdout.write(`Job ${j.id} is still ${j.status}. Check again with /agy:status ${j.id}.\n`);
    return;
  }
  process.stdout.write(render(j) + "\n");
}

function killTree(pid) {
  if (!pid || !pidAlive(pid)) return;
  if (IS_WIN) run("taskkill", ["/PID", String(pid), "/T", "/F"]);
  else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

function cmdCancel(argv) {
  const id = argv.find((a) => !a.startsWith("--"));
  const j = pickJob(id);
  if (j.status !== "running" && j.status !== "queued") {
    process.stdout.write(`Job ${j.id} is already ${j.status}.\n`);
    return;
  }
  // Only the processes this plugin started for the job: agy itself, then its worker.
  j.status = "cancelled";
  j.finishedAt = new Date().toISOString();
  saveJob(j);
  killTree(j.agyPid);
  if (j.workerPid && j.workerPid !== process.pid) killTree(j.workerPid);
  if (j.snapshot && j.gitRoot) removeSnapshot(j.gitRoot, j.snapshot);
  process.stdout.write(`Cancelled ${j.id}.\n`);
}

function cmdResumeCandidate(argv) {
  const conv = lastConversationFor(process.cwd());
  const out = { available: Boolean(conv), conversationId: conv };
  process.stdout.write((argv.includes("--json") ? JSON.stringify(out) : conv ? `last conversation: ${conv}` : "none") + "\n");
}

async function cmdWorker(argv) {
  const job = loadJob(argv[0]);
  if (!job) process.exit(1);
  job.workerPid = process.pid;
  saveJob(job);
  await executeJob(job);
}

// ---------- main ----------

const [cmd, ...argv] = process.argv.slice(2);
const commands = {
  setup: cmdSetup,
  task: cmdTask,
  review: cmdReview,
  status: cmdStatus,
  result: cmdResult,
  cancel: cmdCancel,
  "resume-candidate": cmdResumeCandidate,
  _worker: cmdWorker,
};
if (!commands[cmd]) {
  process.stdout.write(
    "usage: agy-companion.mjs <setup|task|review|status|result|cancel|resume-candidate> [options]\n" +
      "  task   [--background] [--read-only] [--allow-shell] [--resume-last|--fresh] [--model m] [--effort e] <text or stdin>\n" +
      "  review [--background] [--adversarial] [--base <ref>] [--model m] [focus text]\n",
  );
  process.exit(cmd ? 1 : 0);
}
Promise.resolve(commands[cmd](argv)).catch((e) => die(e?.stack || String(e)));
