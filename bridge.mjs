#!/usr/bin/env node
// jam bridge — runs Claude Code sessions on this machine (one per room) and streams them to jam rooms.
// usage: node bridge.mjs [--host jam.example.com] [--key <owner key>] [--only room1,room2]
//   env: JAM_HOST, JAM_KEY (or a .jam-key file next to this script), JAM_CLAUDE (path to the claude binary)
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync, unlinkSync, renameSync, rmSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { route, TIERS, ORDER, SMALL_WINDOW_SAFE } from "./route.mjs";
import { parsePrices, shapeModels } from "./catalog.mjs";
import { loadWeights, runTuning } from "./tune-router.mjs";
import { ScheduleManager } from "./schedule.mjs";
import { driverSandbox as wrapDriver, HOOK_CMD, runLocalVerdict, reapDriver } from "./sandbox.mjs";
import { learnRate, learnedRates } from "./budget.mjs";
import { closingText } from "./turntext.mjs";
// 2026-10-09 review: the pure/stateful pieces below used to live in this file as ~25 module-level globals and could only be exercised
// through a live claude. Each has a *.test.mjs sibling run by check.sh. Spawns and the ws.onmessage handlers stay HERE on purpose:
// check.sh's guards match their literal shape in bridge.mjs.
import { newTurnState, reduceStreamEvent, estimateCost } from "./turn-events.mjs";
import { LIMIT_RE, AUTH_RE, isCapHit, decideResult, decideNoResult } from "./turn-policy.mjs";
import { createModels } from "./models.mjs";
import { createStore } from "./session-store.mjs";
import { COMPACT_MIN_TURNS, COMPACT_IDLE_MS, kfmt, handoffInput, compactAttempts, transcriptTail, hardCompactDue, idleCompactDue } from "./compaction.mjs";
import { bridgeOpensRoom, isAbsCwd, isDuplicateSay, rememberSay, isCompactCommand, isRouterMiss, sessionEvent } from "./room-dispatch.mjs";
import { createUploads } from "./uploads.mjs";
import { runScheduleCli } from "./schedule-cli.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > -1 ? process.argv[i + 1] : d; };
const host = arg("host", process.env.JAM_HOST || "");
const key = arg("key", process.env.JAM_KEY || (existsSync(path.join(here, ".jam-key")) ? readFileSync(path.join(here, ".jam-key"), "utf8").trim() : ""));
const only = (arg("only", process.env.JAM_ONLY || "") || "").split(",").map(s => s.trim()).filter(Boolean);
const claudeBin = process.env.JAM_CLAUDE || "claude";
if (!key) { console.error("need --key, JAM_KEY, or a .jam-key file"); process.exit(1); }
if (!host) { console.error("need --host, JAM_HOST env var, or JAM_HOST in .env (e.g. jam.yourname.workers.dev)"); process.exit(1); }

const stateDir = path.join(os.homedir(), ".jam"); mkdirSync(path.join(stateDir, "sessions"), { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
// Model/cap/window state lives in models.mjs; these aliases keep the call sites below unchanged. Usage caps ("You've reached your Fable
// limit…") come back as an is_error result, not a crash: a capped model is remembered for an hour so routing and compaction step around it.
// Test hooks: JAM_CAPPED=model,model starts those models capped; JAM_WINDOWS={"model":tokens} shrinks a window, so a
// test can make a session "too big" for a model without burning 150k tokens.
const WINDOW_OVERRIDE = (() => { try { return JSON.parse(process.env.JAM_WINDOWS || "{}"); } catch { return {}; } })();
const M = createModels({ TIERS, ORDER, SMALL_WINDOW_SAFE, windowOverride: WINDOW_OVERRIDE, log });
for (const m of (process.env.JAM_CAPPED || "").split(",").map(s => s.trim()).filter(Boolean)) M.capped.set(m, Infinity);
const { isCapped, markCapped, windowOf, fits, fallbackTier, labelOf, tierOf, supportsEffort } = M;
// Host state (sessions, queues, user colors) lives in session-store.mjs, rooted at ~/.jam.
const store = createStore({ stateDir, home: os.homedir(), log });
const { saveQueue, loadQueue, queueFile, seedFile, notesFile, sessionFor, saveSession, assignColor } = store;
const userColors = store.userColors; // one object for the life of the process: the store only ever mutates it

/* ── schedule CLI commands: --list-schedules, --add-schedule room prompt cron [--tier t], --remove-schedule room [cron] (schedule-cli.mjs).
   Detected anywhere in argv so a stray leading flag can never fall through into a full bridge start: a second bridge on the live
   room would race the real one for queued turns. ── */
{ const code = runScheduleCli(process.argv, { stateDir, only }); if (code !== null) process.exit(code); }

/* ── one bridge per hub: a second bridge on the same host runs every turn a second time, possibly on older code (found 2026-09-29:
   an orphan started 15:40 raced the launchd bridge until /restart). Newest wins — it stops the previous holder, so a stray
   never survives the supervised instance's next start. Keyed by host; local test hubs are exempt so parallel test bridges don't collide. ── */
if (host && !only.length && !/^(127\.|localhost|\[?::1)/.test(host)) { // JAM_ONLY bridges (run-tests.sh) intentionally share the prod host with the live one
  const lock = path.join(stateDir, "bridge-" + host.replace(/[^\w.-]/g, "_") + ".pid");
  try {
    const old = parseInt(readFileSync(lock, "utf8"), 10);
    if (old && old !== process.pid && /bridge\.mjs/.test(spawnSync("ps", ["-o", "command=", "-p", String(old)], { encoding: "utf8" }).stdout || "")) {
      log(`another bridge (pid ${old}) already serves ${host} — stopping it`); try { process.kill(old, "SIGTERM"); } catch {}
    }
  } catch {}
  writeFileSync(lock, String(process.pid));
}

/* ── router self-tuning: nightly re-fit of the score cutoffs from logged misses (see tune-router.mjs) ── */
let routerWeights = loadWeights(stateDir);
function retune() {
  const { weights, notes } = runTuning(stateDir);
  if (notes.length) { routerWeights = weights; log("router retuned:", notes.join("; ")); }
}
setTimeout(retune, 30000); // shortly after boot, in case the bridge was down over the last scheduled run
setInterval(retune, 24 * 3600 * 1000);

/* ── scheduled turns: recurring prompts injected into rooms (see schedule.mjs) ── */
const schedules = new ScheduleManager(stateDir);
function checkScheduledTurns() {
  schedules.load(); // re-read ~/.jam/scheduled.json so CLI add/remove/--tier edits apply without a bridge restart (and are never clobbered by a stale in-memory save)
  // don't mark globally; only mark schedules when we actually queue them on a room we own
  const now = new Date();
  const toCheck = schedules.all().filter(s => { try { return s.shouldRun(now); } catch { return false; } });
  for (const sched of toCheck) {
    const r = rooms.get(sched.room);
    if (r && !r.closed) {
      const item = { id: "sched-" + randomUUID(), type: "say", text: sched.prompt, from: "scheduler", role: "scheduler", forceTier: sched.tier || null, ts: Date.now(), attachments: [] };
      r.queue.push(item);
      r.lastActivity = Date.now();
      sched.markRun(); // mark only after queueing on a room this bridge owns
      if (sched.when === "now") schedules.removeByCron(sched.room, "now"); // one-shot: never re-check it, don't clutter the list
      else schedules.save();
      const late = Date.now() - (sched.dueAt || Date.now());
      log(`#${sched.room}`, late > 90000 ? `scheduled turn queued (catch-up: due ${new Date(sched.dueAt).toISOString().slice(11, 16)} UTC, ${Math.round(late / 60000)} min late)` : "scheduled turn queued");
      pump(r);
    }
  }
}
// interval started after rooms map is created (see below)

/* ── approval hook settings (PreToolUse → approve-hook.mjs) ── */
const hookPath = path.join(here, "approve-hook.mjs");
const settingsPath = path.join(stateDir, "settings.json");
writeFileSync(settingsPath, JSON.stringify({
  // Matcher is ".*" (every tool) since 2026-09-29: classify() default-denies unnamed tools, and a tool missing from a name list
  // never reaches it (MCP tools like Gmail send, CronCreate, Workflow used to bypass the hook entirely). Original note:
  // Must list every tool classify() in approve-hook.mjs knows how to gate — Claude Code only invokes a
  // PreToolUse hook for tool names that match this matcher, so a tool covered in classify() but missing here
  // is dead code: the gate never runs and the tool executes unimpeded. (Read/Grep/Glob/WebFetch were added to
  // classify() on 2026-09-21 but omitted here, silently reopening the exact "Read ~/.ssh/id_rsa streams into
  // the room" P0 that classify() change was meant to close — sam-security caught this in review the same day.)
  hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: HOOK_CMD, timeout: 900 }] }] }
}, null, 1));

/* ── teammates: ~/.claude/agents/*.md → @mentions ── */
function loadAgents() {
  const dir = path.join(os.homedir(), ".claude", "agents"); const out = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const src = readFileSync(path.join(dir, f), "utf8");
      const fm = /^---\n([\s\S]*?)\n---/.exec(src); const get = k => (fm && new RegExp("^" + k + ":\\s*(.*)$", "m").exec(fm[1]) || [])[1]?.trim();
      const id = get("name") || f.replace(/\.md$/, "");
      const desc = (get("description") || "").replace(/^["']|["']$/g, "");
      const m = /^([A-Z][\w'-]+(?:\s[A-Z][\w'-]+)*)\s*,/.exec(desc);
      out.push({ id, name: m ? m[1] : id, desc: desc.slice(0, 140) });
    }
  } catch {}
  return out;
}
const agents = loadAgents();
const SYSTEM_NOBROWSER = "You are in a shared jam session with several humans typing into one conversation. Every message is prefixed with the speaker's name in square brackets. Keep track of who said what, address people by name when it matters, and treat disagreements between them as a discussion to help resolve, not instructions to follow blindly. Be concise; this renders in a chat window." +
  (agents.length ? " Teammates available as subagents: " + agents.map(a => `@${a.id} (${a.name}${a.desc ? ": " + a.desc.replace(/^[^,]*,\s*/, "").slice(0, 90) : ""})`).join("; ") + ". Pull one in on your own judgment whenever the task fits their specialty — a QA pass before something reaches real users, a security look at auth or hook changes, a data cross-check, a deploy health check — and when a message @mentions <id>, always run that request through it. Use the Agent tool with subagent_type = the id, give it what it needs (it cannot see this room), and relay the result crediting the teammate by name. Leave them idle when the work is ordinary; do not delegate for show." : "");
// Drivers get no browser paragraph: browser.mjs needs the hub key and a writable ~/.jam profile, neither of which a sandboxed driver shell has.
const SYSTEM_BROWSER = " You have a real headless browser: `node browser.mjs '<json-array-of-steps>'` via Bash, run from this cwd. Steps: {action:\"goto\",url}, {action:\"click\",selector}, {action:\"fill\",selector,text}, {action:\"press\",selector,key}, {action:\"wait\",ms} or {action:\"wait\",selector}, {action:\"eval\",js}, {action:\"text\"}, {action:\"screenshot\",caption}. Chain multiple steps in one call for a flow (fill several fields, then submit) — a fresh call re-launches the page and loses any unsaved in-page state, though cookies/login persist per room. Every call (unless you pass --silent) posts a screenshot card into the room for everyone to see, so use it for anything visual — checking a live page, QA'ing a deploy, showing Mike a result — not just as your own scratch space.";
const SYSTEM_BASE = SYSTEM_NOBROWSER + SYSTEM_BROWSER;
const systemFor = item => item.role === "driver" ? SYSTEM_NOBROWSER : SYSTEM_BASE;

/* ── compaction: replace a long session with a handoff summary + fresh session (thresholds, prompts and attempt order: compaction.mjs) ──
   hard / soft / manual triggers are documented in compaction.mjs. */
/* ── room notes: durable memory that outlives every compaction, not just the next one ──
   Unlike the one-shot handoff (seedFile, consumed after a single turn), this is prepended on every turn and
   Claude maintains it directly with Edit/Write — decisions, house rules, who's who don't drift after 3-4 compactions. */
function notesFor(r) { // notesFile comes from session-store.mjs
  let content = ""; try { content = readFileSync(notesFile(r), "utf8").trim(); } catch {}
  return `[Room notes — durable memory for #${r.cfg.name}, kept at ${notesFile(r)} and shown to you at the start of every turn; it survives every compaction, unlike the one-shot handoff. Use the Edit or Write tool on that file directly whenever something durable is worth keeping: decisions and why, house rules, who's who, standing commitments. Keep it under 1500 words and prune what's stale. ` +
    (content ? "Current notes:]\n\n" + content : "It's empty — nothing recorded yet.]") + "\n\n---\n\n";
}

async function compact(r, why) {
  const chargeTo = /^requested by /.test(why) ? r.compactFor : null; r.compactFor = null; // only the compaction a driver typed /compact for
  if (r.child || r.compacting || r.closed) return false;
  if (r.fresh || !r.lastCtx) { r.send({ type: "sys", text: "Nothing to compact yet — this session is fresh.", ts: Date.now() }); setTimeout(() => pump(r), 50); return false; } // pump: a requeued message is waiting on this
  r.compacting = true; r.running = true; r.since = Date.now(); r.warnedStale = false; r.lastTool = "compacting — writing the handoff";
  r.send({ type: "sys", text: `Compacting the session (${why}): writing a handoff, then starting fresh…`, ts: Date.now() });
  log(`#${r.cfg.name}`, "compact:", why, "ctx", kfmt(r.lastCtx));
  // First reload the session and ask it for its own handoff: the room's pinned model, then heavy, medium, light,
  // skipping any that are capped or whose window can't hold it. If none can (it grew on a bigger window that is now
  // capped), write the handoff from the transcript tail in a fresh session instead, so there is always a way out.
  // The failure reason arrives in stdout's JSON, not stderr, so that is what gets logged: an empty
  // "compact failed 1" hid the Fable cap for hours on 2026-09-11.
  const pinned = r.cfg.model && r.cfg.model !== "auto" ? r.cfg.model : null;
  const attempts = compactAttempts({ pinned, tiers: TIERS, fits, windowOf, lastCtx: r.lastCtx });
  const env = { ...process.env, CLAUDECODE: undefined };
  let ev = null, summary = "", used = null, fromTranscript = false, tail = null, tries = 0; const reasons = [];
  for (const { m, resume } of attempts) {
    if (isCapped(m)) continue;
    if (!resume) { if (tail === null) tail = transcriptTail(os.homedir(), r.sessionId); if (!tail || tries >= 2) break; tries++; }
    const args = ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--settings", settingsPath, "--model", m, ...(resume ? ["--resume", r.sessionId] : ["--tools", ""])]; // transcript text is untrusted: no tools
    const input = handoffInput({ resume, roomName: r.cfg.name, tail }); // transcript text is framed as material (switch.test, 2026-09-11)
    const out = await new Promise(res => {
      let settled = false; const done = payload => { if (settled) return; settled = true; res(payload); };
      const ch = r.child = spawn(claudeBin, args, { cwd: r.cfg.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      let o = "", e = ""; ch.stdout.on("data", d => o += d); ch.stderr.on("data", d => e += d);
      ch.on("close", code => done({ code, o, e }));
      // spawn() can fail asynchronously (ENOENT if claudeBin briefly vanished mid self-update, EACCES, …); with no
      // listener Node throws and kills the whole bridge, taking every other room down with it (2026-09-28 outage).
      ch.on("error", err => done({ code: -1, o, e: e + `\nspawn error: ${err.message}` }));
      ch.stdin.end(input);
    });
    r.child = null;
    let j = null; try { j = JSON.parse(out.o); } catch {}
    const s = j && !j.is_error ? String(j.result || "").trim() : "";
    if (s.length >= 200) { ev = j; summary = s; used = m; fromTranscript = !resume; break; }
    const why = String((j && j.result) || out.e || `exit ${out.code}`).replace(/\s+/g, " ").trim();
    if (LIMIT_RE.test(why)) markCapped(m, why);
    reasons.push(`${labelOf(m)}${resume ? "" : " (transcript)"}: ${why.slice(0, 160)}`);
    if (r.closed || r.stopped) break;
  }
  if (!summary) {
    const why = reasons.length ? reasons.join("; ") : `no available model can hold ${kfmt(r.lastCtx || 0)} of context`;
    log(`#${r.cfg.name}`, "compact failed:", why); r.send({ type: "sys", text: `Compaction failed; keeping the current session. ${why}`, ts: Date.now() });
    r.compacting = false; r.running = false; r.turnsSinceCompact = 0; setTimeout(() => pump(r), 50); return false;
  }
  const before = r.lastCtx, stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(seedFile(r), summary); writeFileSync(path.join(stateDir, "sessions", `${r.cfg.name}-handoff-${stamp}.md`), summary);
  r.sessionId = randomUUID(); r.fresh = true; r.seed = summary; r.lastCtx = Math.round(summary.length / 4) + 4000; r.turnsSinceCompact = 0; saveSession(r);
  const mu = Object.values(ev.modelUsage || {})[0];
  const text = `Compacted: ${kfmt(before)} → about ${kfmt(r.lastCtx)} of context. Handoff saved (${summary.split(/\s+/).length} words); fresh session started.` +
    (fromTranscript ? ` No available model could reload the full session, so ${labelOf(used)} wrote the handoff from the transcript.` : "");
  try { appendFileSync(path.join(stateDir, "compactions.jsonl"), JSON.stringify({ ts: Date.now(), room: r.cfg.name, why, before, after: r.lastCtx, words: summary.split(/\s+/).length, cost: ev.total_cost_usd, ms: ev.duration_ms, model: used, fromTranscript }) + "\n"); } catch {}
  log(`#${r.cfg.name}`, text, `$${(ev.total_cost_usd || 0).toFixed(2)}`, "via", labelOf(used));
  r.send({ type: "sys", text, ts: Date.now() });
  r.send({ type: "compacted", ctx: r.lastCtx, ctxMax: mu?.contextWindow || null, before, cost: ev.total_cost_usd }); addPlanCost(ev.total_cost_usd);
  if (chargeTo) r.send({ type: "spend", id: chargeTo, cost: ev.total_cost_usd || 0, model: used, final: true }); // a /compact a driver typed is on their budget
  r.compacting = false; r.running = false; r.compactWanted = null;
  r.send(sessionEvent(r));
  setTimeout(() => pump(r), 50); return true;
}
function seedFor(r) { if (r.seed) return r.seed; try { return readFileSync(seedFile(r), "utf8"); } catch { return null; } }
/* ── per-room session state ── */
const rooms = new Map(); // name -> { cfg, ws, queue, running, child, sessionId, fresh, timer }
/* ── plan usage: the subscription's 5-hour and weekly limits, read the way `claude /usage` does (the account's OAuth
   token from the Claude Code keychain entry, or ~/.claude/.credentials.json elsewhere). The tokens gauge is context,
   not quota: on 2026-09-14 it read "plenty left" while the account was out of tokens for the window and Claude
   answered nothing. Best effort — no credentials or an API refusal just leaves the row blank in the UI. ── */
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage", USAGE_MS = 2 * 60 * 1000;
let lastUsage = null, usageWarned = "", usageFailLogged = false, usageAt = 0, usageBackoff = 0;
/* ── per-driver budgets (budget.mjs): every plan reading goes to the Hub with a learned plan-%-per-$ rate. The rate comes
   from watching plan % move against the running total of every jam turn's cost (persisted, so a restart keeps learning). ── */
const RATE_FILE = path.join(stateDir, "plan-rate.json");
let planRate = (() => { try { return JSON.parse(readFileSync(RATE_FILE, "utf8")) || {}; } catch { return {}; } })(), lastPlan = null;
function readPlanRate() { try { return JSON.parse(readFileSync(RATE_FILE, "utf8")) || {}; } catch { return {}; } }
function savePlanRate() { try { writeFileSync(RATE_FILE + ".tmp" + process.pid, JSON.stringify(planRate)); renameSync(RATE_FILE + ".tmp" + process.pid, RATE_FILE); } catch {} }
// re-read before every write: test bridges and the live one share this file, and neither may erase the other's total
function addPlanCost(c) { if (Number(c) > 0) { planRate = readPlanRate(); planRate.costTotal = Math.round(((planRate.costTotal || 0) + Number(c)) * 10000) / 10000; savePlanRate(); } }
function readClaudeToken() {
  try {
    let raw = "";
    if (process.platform === "darwin") { const r = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8" }); if (r.status === 0) raw = r.stdout; }
    if (!raw) { const f = path.join(os.homedir(), ".claude", ".credentials.json"); if (existsSync(f)) raw = readFileSync(f, "utf8"); }
    return (JSON.parse(raw || "{}").claudeAiOauth || {}).accessToken || "";
  } catch { return ""; }
}
async function pollUsage() {
  if (Date.now() < usageBackoff) return; // every caller (interval, post-turn, page load) respects a 429 backoff
  usageAt = Date.now();
  const tok = readClaudeToken(); if (!tok) return;
  try {
    const res = await fetch(USAGE_URL, { headers: { Authorization: "Bearer " + tok, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (res.status === 429) usageBackoff = Date.now() + 4 * 60 * 1000; // the usage endpoint rate-limits hard: back off, keep showing the last reading
    if (res.status === 401 || res.status === 403) checkAuth("plan usage returned HTTP " + res.status); // the same OAuth token the turns use
    if (!res.ok) { if (!usageFailLogged) { usageFailLogged = true; log("plan usage unavailable: HTTP", res.status); } return; }
    const u = await res.json();
    const limits = (u.limits || []).map(l => ({ kind: l.kind, group: l.group, percent: Math.round(+l.percent || 0), resetsAt: l.resets_at ? Date.parse(l.resets_at) : null, scope: l.scope?.model?.display_name || null, active: !!l.is_active }));
    if (!limits.length) return;
    lastUsage = { type: "usage", limits, ts: Date.now() };
    for (const r of rooms.values()) r.send(lastUsage);
    planRate = readPlanRate(); planRate = learnRate(planRate, limits, planRate.costTotal || 0); savePlanRate();
    lastPlan = { type: "plan", limits, rate: learnedRates(planRate), ts: lastUsage.ts };
    try { hubWs && hubWs.readyState === 1 && hubWs.send(JSON.stringify(lastPlan)); } catch {}
    // one heads-up per window when the 5-hour limit gets close — before turns start coming back empty
    const s = limits.find(l => l.kind === "session"), tag = s && s.resetsAt ? String(s.resetsAt) : "";
    if (s && s.percent >= 90 && usageWarned !== tag) {
      usageWarned = tag; const at = s.resetsAt ? new Date(s.resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "soon";
      for (const r of rooms.values()) r.send({ type: "sys", owners: true, text: `Plan usage is at ${s.percent}% of the 5-hour window — Claude may stop answering until it resets at ${at}.`, ts: Date.now() });
    }
  } catch (e) { if (!usageFailLogged) { usageFailLogged = true; log("plan usage unavailable:", e.message || e); } }
}
/* ── host auth: every turn runs as whatever Claude Code is logged into on this machine, so an expired login reaches
   the room as a wall of OAuth errors with no way to fix it from there — you had to know to go find a terminal. Now a
   failure that smells like auth is verified against the CLI's own `claude auth status` (the authority, so a stray
   word in an error never cries wolf) and the owner can run the login from the room: the bridge starts
   `claude auth login`, relays the URL it prints, and pipes the code back to the waiting process. Owner-only end to
   end — the Worker drops a login from anyone else — and the code is never logged or stored anywhere. ── */
let authState = null, loginChild = null, lastCode = "";
function authStatus() {
  try {
    const r = spawnSync(claudeBin, ["auth", "status"], { encoding: "utf8", timeout: 20000 });
    const j = JSON.parse((r.stdout || "").trim() || "{}");
    return { loggedIn: !!j.loggedIn, email: String(j.email || ""), plan: String(j.subscriptionType || ""), method: String(j.authMethod || "") };
  } catch { return null; }
}
const redact = t => lastCode ? String(t).split(lastCode).join("<code>") : String(t); // the CLI may echo a bad code back; it never leaves this machine
function sendAuth(o) { authState = { ...o, ts: Date.now() }; for (const r of rooms.values()) r.send({ type: "auth", ...authState }); }
function checkAuth(why) {
  const st = authStatus(); if (!st) return false;
  if (!st.loggedIn) { log("host auth: logged out —", why); sendAuth({ state: "out", why: String(why || "").slice(0, 120) }); return true; }
  if (authState && authState.state !== "in") sendAuth({ state: "in", email: st.email, plan: st.plan });
  return false;
}
function startLogin(by) {
  if (loginChild) { if (authState) sendAuth(authState); return; }             // already waiting on a code: re-show the card
  log("host auth: `claude auth login` started by", by);
  sendAuth({ state: "starting", by: String(by || "").slice(0, 32) });
  const ch = loginChild = spawn(claudeBin, ["auth", "login"], { cwd: here, env: { ...process.env, CLAUDECODE: undefined }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", sentUrl = false;
  const scan = d => {
    out += d; if (out.length > 20000) out = out.slice(-20000);
    if (sentUrl) return;
    const m = /https:\/\/(?:claude\.com|claude\.ai|platform\.claude\.com|console\.anthropic\.com)\/[^\s'"]*/i.exec(out); // only ever hand the owner a link to Anthropic's own sign-in
    if (m) { sentUrl = true; sendAuth({ state: "url", url: m[0].slice(0, 700) }); }
  };
  ch.stdout.on("data", scan); ch.stderr.on("data", scan);
  const giveUp = setTimeout(() => { try { ch.kill("SIGKILL"); } catch {} }, 10 * 60 * 1000);
  ch.on("close", () => {
    clearTimeout(giveUp); loginChild = null;
    const st = authStatus();
    if (st && st.loggedIn) { log("host auth: logged in as", st.email); sendAuth({ state: "in", email: st.email, plan: st.plan }); }
    else { log("host auth: login did not complete"); sendAuth({ state: "failed", tail: redact(out).replace(/\s+/g, " ").trim().slice(-160) }); }
  });
  ch.on("error", e => { clearTimeout(giveUp); loginChild = null; log("host auth: login failed to start:", e.message || e); sendAuth({ state: "failed", tail: String(e.message || e).slice(0, 160) }); });
}
// the code the login page hands back. Straight to the waiting process's stdin, never logged, never stored.
function loginCode(code) {
  if (!loginChild) { sendAuth({ state: "failed", tail: "no sign-in is waiting for a code — start one again" }); return; }
  lastCode = String(code).trim();
  // the child can exit between the card arriving and the code being typed: a dropped write must not leave the room
  // sitting on "checking" forever, and node reports that as a false return, not a throw
  try {
    const wrote = loginChild.stdin.write(lastCode + "\n");
    if (wrote === false && loginChild.stdin.destroyed) { sendAuth({ state: "failed", tail: "the sign-in on the host had already exited — start one again" }); return; }
    sendAuth({ state: "checking" });
  } catch (e) { sendAuth({ state: "failed", tail: String(e.message || e).slice(0, 160) }); }
}
// a half-finished sign-in must never outlive the bridge that started it (a restart would orphan it, and two of them
// race for the same credentials file)
for (const sig of ["exit", "SIGTERM", "SIGINT"]) process.on(sig, () => { if (loginChild) { try { loginChild.kill("SIGKILL"); } catch {} loginChild = null; } });
/* ── model catalog: which models exist, their context windows and effort levels (Anthropic Models API, same OAuth
   token as plan usage) plus per-token prices (Anthropic's published pricing page — there is no pricing API). Refreshed
   at startup, hourly, and whenever someone opens or reloads a room or the lobby, so a new model, a retirement, or a
   price change shows up without a jam release. Auto-routing follows it too: light/medium/heavy advance to the newest
   Haiku/Sonnet/Opus. Fable is never auto-routed (scarce quota) — pin it by hand. ── */
const MODELS_URL = "https://api.anthropic.com/v1/models?limit=100";
const PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing.md";
const FAMILY_TIER = { haiku: "light", sonnet: "medium", opus: "heavy" };
let catalogAt = 0, catalogBackoff = 0, catalogFailLogged = false, lastPrices = {}, hubWs = null;
const CATALOG_OFF = process.env.JAM_CATALOG === "off"; // run-tests.sh: keep the hardcoded tiers so caps/windows in tests stay deterministic
async function refreshCatalog() {
  if (CATALOG_OFF || Date.now() < catalogBackoff) return;
  catalogAt = Date.now();
  const tok = readClaudeToken(); if (!tok) return;
  try {
    const [mr, pr] = await Promise.all([
      fetch(MODELS_URL, { headers: { Authorization: "Bearer " + tok, "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(15000) }),
      fetch(PRICING_URL, { signal: AbortSignal.timeout(15000) }).catch(() => null)]);
    if (!mr.ok) { if (mr.status === 429) catalogBackoff = Date.now() + 4 * 60 * 1000; if (!catalogFailLogged) { catalogFailLogged = true; log("model catalog unavailable: HTTP", mr.status); } return; }
    catalogFailLogged = false;
    if (pr && pr.ok) { const p = parsePrices(await pr.text()); if (Object.keys(p).length) lastPrices = p; } // keep the last good prices if the page is down or reshaped
    const models = shapeModels((await mr.json()).data, lastPrices);
    if (!models.length) return;
    for (const [fam, tier] of Object.entries(FAMILY_TIER)) {
      const m = models.find(x => x.current && x.family === fam); if (!m) continue;
      if (TIERS[tier].model !== m.id) log("router:", tier, TIERS[tier].model, "→", m.id, "(newest " + fam + ")");
      Object.assign(TIERS[tier], { model: m.id, label: m.label, ...(m.window ? { window: m.window } : {}) });
    }
    M.catalog = { type: "catalog", models, tiers: Object.fromEntries(ORDER.map(t => [t, TIERS[t].model])), ts: Date.now() };
    for (const r of rooms.values()) r.send(M.catalog);
    try { hubWs?.readyState === 1 && hubWs.send(JSON.stringify(M.catalog)); } catch {}
  } catch (e) { if (!catalogFailLogged) { catalogFailLogged = true; log("model catalog unavailable:", e.message || e); } }
}
// someone opened or reloaded a room (or the lobby): re-read quota and the catalog now. Throttled, so a burst of
// reloads is one API call. Nothing is re-sent inside the window — hello already carried the stored copy.
function refreshLive(catalogOnly) {
  if (!catalogOnly && !CATALOG_OFF && Date.now() - usageAt > 60000) pollUsage(); // test bridges (JAM_CATALOG=off) leave the real quota endpoint alone
  if (Date.now() - catalogAt > 60000) refreshCatalog();
}
function runOne(r, item) {
  r.running = true; r.current = item.id; r.runningItem = item; r.since = Date.now(); r.warnedStale = false; r.lastTool = null; r.currentTask = null; r.send({ type: "start", id: item.id });
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--dangerously-skip-permissions", "--settings", settingsPath,
    // Only the owner's user settings load: a room's .claude/settings.json (env, hooks, apiKeyHelper, statusLine) and .mcp.json are
    // files a driver could plant, and they'd otherwise run with owner rights and override the bridge's own env (sam-security, 9/29).
    "--setting-sources", "user", "--append-system-prompt", systemFor(item),
    r.fresh ? "--session-id" : "--resume", r.sessionId];
  // a driver near their budget (worker flags the message "downshift") runs on the light tier, whatever the room pins
  const downshift = item.budget === "downshift";
  const auto = !r.cfg.model || r.cfg.model === "auto" || downshift;
  const seed = r.fresh ? seedFor(r) : null;
  const roomTier = r.cfg.tier && r.cfg.tier !== "auto" ? r.cfg.tier : null; // owner's manual "effort" override, applies to every auto-routed turn until changed
  const pick = auto ? route(item.text, { attachments: (item.attachments || []).length, mention: /(^|\s)@[a-z][\w-]{2,}/i.test(item.text || ""), role: item.role, forceTier: downshift ? "light" : item.forceTier || roomTier, ctx: r.lastCtx || 0, bump: (item.bump || 0) + (seed ? 2 : 0), thresholds: routerWeights }) : null;
  let model = auto ? pick.model : r.cfg.model, swapped = null;
  // The same safety net for an auto pick and a hand-picked model: step around a usage cap to the nearest model that
  // fits, and compact before loading a session into a window it has outgrown (a hand-switch from a big Fable session
  // to Sonnet used to just error). A hand-picked model stays the room's pick; it's swapped for this turn only.
  const ctxNow = r.fresh ? 0 : (r.lastCtx || 0), chosen = auto ? pick.label : labelOf(model);
  if (isCapped(model) || !fits(windowOf(model), ctxNow)) {
    const ft = isCapped(model) ? fallbackTier(auto ? pick.tier : (tierOf(model) || "heavy"), ctxNow) : null;
    const allCapped = M.allCapped(model); // the cap is account-wide: can happen
    if (ft) {
      swapped = `${chosen} capped → ${TIERS[ft].label}`; log(`#${r.cfg.name}`, swapped); model = TIERS[ft].model;
      if (auto) { pick.why += ", " + swapped; pick.tier = ft; pick.label = TIERS[ft].label; }
    } else if (!item.capCompacted && ctxNow > 0 && !allCapped) {
      item.capCompacted = true; r.running = false; r.current = null; r.runningItem = null; r.queue.unshift(item); saveQueue(r);
      r.compactWanted = `requested: ${chosen} ${isCapped(model) ? "is capped and the other models can't hold" : "can't hold"} ${kfmt(ctxNow)} of context`;
      setTimeout(() => pump(r), 50); return;
    } else {
      r.running = false; r.current = null; r.runningItem = null;
      r.send({ type: "error", id: item.id, text: allCapped ? "Every model is at its usage limit right now, so this message can't run. Send it again once a limit resets."
        : `${chosen} ${isCapped(model) ? "hit its usage limit" : "can't hold this session"} and compacting didn't bring the session down far enough. Pick another model, or try /compact.` });
      setTimeout(() => pump(r), 50); return;
    }
  }
  args.push("--model", model);
  const effort = r.cfg.effort && r.cfg.effort !== "auto" ? r.cfg.effort : null; // Anthropic's real effort level, not the router tier — apply it to whichever model this turn actually lands on
  if (effort && supportsEffort(model, effort)) args.push("--effort", effort);
  if (auto && seed) pick.why = "first turn after compaction — absorbing the handoff";
  if (downshift) pick.why = "light model for this message"; // neutral: the whole room sees route reasons
  if (auto) { r.send({ type: "route", id: item.id, tier: pick.tier, label: pick.label, why: pick.why, score: pick.score }); log(`#${r.cfg.name}`, "route →", pick.tier, `(${pick.score})`, pick.why); }
  else if (swapped) r.send({ type: "route", id: item.id, tier: tierOf(model), label: labelOf(model), why: `${swapped} for this turn; the room stays on ${chosen}`, score: null });
  log(`#${r.cfg.name}`, "turn", item.id.slice(0, 8), r.fresh ? "(new session)" : "(resume)", "from", item.from, item.role || "");
  item.startedAt = Date.now(); item.model = model; item.tier = auto ? pick.tier : "manual"; item.score = auto ? pick.score : null;
  const env = { ...process.env, CLAUDECODE: undefined, JAM_HOST: host, JAM_KEY: key, JAM_ROOM: r.cfg.name, JAM_FROM: item.from, JAM_FROM_ROLE: item.role || "driver", JAM_TURN: item.id, JAM_CWD: r.cfg.cwd };
  delete env.JAM_RUN_LOCAL; // never inherited: the hook's only source for "the owner trusts drivers' commands in this room" is the line below
  // 2026-10-09 review: only the Seatbelt path (sandbox.mjs) used to scrub JAM_KEY, so off-macOS or with JAM_DRIVER_SANDBOX=off a driver's claude ran with the hub key in its env (readable by any same-uid process). The hook reads .jam-key from disk, so drop it for every driver turn.
  if (item.role === "driver" && existsSync(path.join(here, ".jam-key"))) delete env.JAM_KEY;
  let sb = null, sbErr = "";
  if (item.role === "driver") { try { sb = wrapDriver(r.cfg.cwd, item.id, env); } catch (e) { sbErr = e.message; log(`#${r.cfg.name}`, "driver sandbox failed:", e.message); } }
  // "Run commands on this machine": card-free driver Bash. Only with the Seatbelt actually applied (sb) -- with JAM_DRIVER_SANDBOX=off
  // or off-macOS the shell is unsandboxed, so the Allow card is the only gate and stays -- and never in a room whose directory
  // contains or sits inside jam's own code or ~/.jam, where a card-free interpreter could rewrite the bridge/hook or the queue files.
  if (item.role === "driver" && r.cfg.runLocal === true) {
    const rp = p => { try { return realpathSync(p); } catch { return path.resolve(p); } };
    const v = runLocalVerdict({ runLocal: true, sandboxed: !!sb, cwdReal: rp(r.cfg.cwd), jamCode: rp(here), jamState: rp(path.join(os.homedir(), ".jam")) });
    if (v.on) sb.env.JAM_RUN_LOCAL = "1"; else log(`#${r.cfg.name}`, `run-commands-locally is ON but ${v.why}: commands still need approval`);
  }
  const child = r.child = spawn(sbErr ? "/usr/bin/false" : claudeBin, args, { cwd: r.cfg.cwd, env: sb ? sb.env : env, stdio: ["pipe", "pipe", "pipe"] });
  if (sb) child.once("close", () => { try { const k = reapDriver(sb.scratch); if (k.length) log(`#${r.cfg.name}`, "reaped", k.length, "leftover driver process(es)"); } catch {} try { rmSync(sb.scratch, { recursive: true, force: true }); } catch {} });
  // best-effort: a missing/broken `caffeinate` must never take the turn (or the whole bridge) down with it
  if (process.platform === "darwin") { try { r.caffeinate = spawn("caffeinate", ["-i"], { stdio: "ignore" }); r.caffeinate.on("error", e => { log(`#${r.cfg.name}`, "caffeinate unavailable:", e.message); r.caffeinate = null; }); } catch (e) { log(`#${r.cfg.name}`, "caffeinate unavailable:", e.message); } }
  const att = (item.attachments || []).filter(a => a.path).map(a => a.path);
  const seedText = seed ? `[Handoff from the previous session in this room, written by Claude when the context was compacted. Treat it as established context; do not repeat it back.]\n\n${seed}\n\n---\n\n` : "";
  child.stdin.end(notesFor(r) + seedText + `[${item.from}]: ${item.text}` + (att.length ? `\n\n[Attachments from ${item.from}, saved on this machine: ${att.join(", ")}] — open them with the Read tool (images render).` : ""));
  let buf = "", stderr = ""; const st = newTurnState(); // st.usages: message id → usage, for pricing an attempt that never reaches a result
  if (sbErr) stderr += `\ndriver sandbox unavailable: ${sbErr}`;
  const finish = ev => {
    if (isCapHit(ev)) markCapped(item.model, ev.result);
    const verdict = decideResult({ ev, text: st.text, fresh: r.fresh, item }); // the ordered retry/outcome guards live in turn-policy.mjs
    if (verdict === "capRetry") {
          // a usage cap isn't the answer: retry once on whatever still fits (runOne swaps capped models out, pinned
          // or not). A first turn after compaction retries in a new session so the handoff seed rides along again.
          item.capRetried = true; if (r.fresh) { item.capFresh = true; r.sessionId = randomUUID(); saveSession(r); }
          r.queue.unshift(item); saveQueue(r); r.send({ type: "sys", text: `${labelOf(item.model)} hit its usage limit; retrying that message on another model.`, ts: Date.now() });
    } else if (verdict === "tooLongCompact") {
          // the window estimate was wrong (an unknown model, a stale ctx): compact, then run the message again. The
          // session is at least as big as the window that refused it, so compaction won't retry that model first.
          item.longCompacted = true; r.lastCtx = Math.max(r.lastCtx || 0, windowOf(item.model)); r.queue.unshift(item); saveQueue(r);
          r.compactWanted = `requested: the session is too long for ${labelOf(item.model)}`;
    } else if (verdict === "notResumable") { log(`#${r.cfg.name}`, "session", r.sessionId.slice(0, 8), "not resumable — retrying this turn fresh"); r.fresh = true; item.retried = true; item.retryFresh = true; st.gotResult = false; st.lastResult = null; return; }
    else if (verdict === "error") {
          r.send({ type: "error", id: item.id, text: ev.result || "claude returned an error" });
          if (AUTH_RE.test(String(ev.result || ""))) checkAuth("turn error: " + String(ev.result || "").slice(0, 80)); // expired login → an auth card with a way to fix it, not just the raw error
    } else if (verdict === "emptyRetry") {
          // an instant, empty, non-error result is a turn that never ran (2026-09-14: `--resume` of a session id with
          // no transcript yet returned exactly this, seven times, and the room saw nothing). Never let it be silent.
          item.retriedEmpty = true; item.bump = (item.bump || 0) + 1; r.queue.unshift(item); saveQueue(r);
          log(`#${r.cfg.name}`, "empty instant reply — retrying that turn once"); r.send({ type: "sys", text: "Claude returned nothing for that message; retrying it once.", ts: Date.now() });
    }
        else {
          const it = (ev.usage?.iterations || []).at(-1) || ev.usage || {};
          const ctx = (it.input_tokens | 0) + (it.cache_read_input_tokens | 0) + (it.cache_creation_input_tokens | 0);
          const mu = Object.values(ev.modelUsage || {}).sort((a, b) => ((b.cacheReadInputTokens | 0) + (b.inputTokens | 0)) - ((a.cacheReadInputTokens | 0) + (a.inputTokens | 0)))[0];
          if (ctx) { r.lastCtx = ctx; saveSession(r); }
          M.observeWindows(ev.modelUsage);
          if (seed) { r.seed = null; try { unlinkSync(seedFile(r)); } catch {} }
          r.turnsSinceCompact = (r.turnsSinceCompact | 0) + 1; r.lastActivity = Date.now();
          r.lastDone = { id: item.id, tier: item.tier, ts: Date.now() };
          const windowMax = mu?.contextWindow || windowOf(item.model);
          if (hardCompactDue({ ctx, windowMax, turnsSinceCompact: r.turnsSinceCompact, compactWanted: r.compactWanted })) r.compactWanted = `context reached ${kfmt(ctx)} of ${kfmt(windowMax)} window`;
          // ev.result can come back an empty string on some turns (not just null/undefined) — `??` only falls
          // back on nullish, so an empty ev.result was overriding the real streamed text with nothing. Prefer
          // whichever is non-empty, so the closing message never renders blank.
          r.send({ type: "done", id: item.id, text: closingText(st.text, ev.result) || "(Claude finished without a closing message.)", cost: ev.total_cost_usd, ctx: ctx || null, ctxMax: mu?.contextWindow || null, model: mu?.canonicalModel || item.model, tier: item.tier });
          try {
            appendFileSync(path.join(stateDir, "routing.jsonl"), JSON.stringify({ ts: Date.now(), room: r.cfg.name, from: item.from, id: item.id, tier: item.tier, model: item.model, score: item.score,
              chars: (item.text || "").length, attachments: (item.attachments || []).length, ctx, cost: ev.total_cost_usd, ms: ev.duration_ms, turns: ev.num_turns }) + "\n");
          } catch {}
        }
    log(`#${r.cfg.name}`, "done", item.id.slice(0, 8), ev.duration_ms + "ms"); setTimeout(pollUsage, 4000);
  };
  child.stdout.on("data", d => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      for (const o of reduceStreamEvent(ev, st, item.id)) r.send(o); // stream-json → room events: turn-events.mjs
      r.lastTool = st.lastTool; r.currentTask = st.currentTask; // heartbeats read these off the room
    }
  });
  child.stderr.on("data", d => { stderr += d; });
  let childDone = false;
  const onChildClose = code => {
    if (childDone) return; childDone = true; // 'error' and 'close' can both fire for a failed spawn; run this once
    if (r.caffeinate) { r.caffeinate.kill(); r.caffeinate = null; }
    r.child = null; r.running = false; r.current = null; r.runningItem = null;
    // every attempt costs something, whether it ends in done, an error, a Stop, a crash, or a retry: meter it before
    // done/error goes out, so the room can still tie it to the driver who sent the message
    const attemptCost = st.lastResult && Number.isFinite(st.lastResult.total_cost_usd) ? st.lastResult.total_cost_usd : estimateCost(M.catalog?.models, item.model, st.usages);
    if (attemptCost > 0) { addPlanCost(attemptCost); r.send({ type: "spend", id: item.id, cost: attemptCost, model: item.model }); }
    if (st.lastResult) finish(st.lastResult);
    if (!st.gotResult) {
      const verdict = decideNoResult({ item, fresh: r.fresh, stopped: r.stopped, code, stderr }); // ordered guards: turn-policy.mjs
      if (verdict === "retryFresh") { delete item.retryFresh; r.queue.unshift(item); } // same id, --session-id this time (see session-store.mjs transcriptOf)
      else if (verdict === "lockedAbandon") {
        log(`#${r.cfg.name}`, "session", r.sessionId.slice(0, 8), "still locked — abandoning it for a new one"); item.retriedLocked = true;
        r.sessionId = randomUUID(); r.fresh = true; saveSession(r); r.queue.unshift(item);
        r.send({ type: "sys", text: "That session was still locked from the last restart; starting a new one.", ts: Date.now() });
      }
      else if (verdict === "sessionNotFound") {
        log(`#${r.cfg.name}`, "session not found, starting fresh"); r.fresh = true; r.sessionId = randomUUID(); saveSession(r); item.retried = true; r.queue.unshift(item);
      } else if (verdict === "schedulerRetry") { // scheduler turn crashed: retry once, no weight change (scheduler floor is already set)
        const retry = { ...item, schedulerRetries: (item.schedulerRetries ?? 0) + 1, ts: Date.now() };
        r.queue.unshift(retry);
        log(`#${r.cfg.name}`, "scheduled turn error (retry):", item.id.slice(0, 8));
        r.send({ type: "sys", text: `⚠️ Scheduled turn failed (exit code ${code}); retrying once.`, ts: Date.now() });
      } else if (verdict === "schedulerFinal") {
        r.send({ type: "error", id: item.id, text: `scheduled turn failed after retry: exit code ${code}` + (stderr ? "\n" + stderr.slice(-800) : "") });
        log(`#${r.cfg.name}`, "scheduled turn error (final):", item.id.slice(0, 8));
        r.send({ type: "sys", text: `⚠️ Scheduled turn failed: exit code ${code} — no more retries`, ts: Date.now() });
      } else if (verdict === "crashRetry") { // non-scheduler crash: retry once, one weight up
        log(`#${r.cfg.name}`, "claude exited", code, "without a result — retrying once, heavier"); item.retried2 = true; item.bump = (item.bump || 0) + 1; r.queue.unshift(item);
        r.send({ type: "sys", text: "Claude exited unexpectedly; retrying that message once.", ts: Date.now() });
      } else {
        r.send({ type: "error", id: item.id, text: (code === null ? "stopped" : `claude exited ${code}`) + (stderr ? "\n" + stderr.slice(-800) : "") });
      }
    }
    if (!st.gotResult && code && AUTH_RE.test(stderr)) checkAuth(`claude exited ${code}: ` + stderr.replace(/\s+/g, " ").trim().slice(-80));
    if (r.fresh && st.gotResult) { if (item.capFresh) item.capFresh = false; else r.fresh = false; }
    if (r.pendingCfg) { // deferred directory change: reopen there, carrying the queue
      const c = r.pendingCfg, q = r.queue; r.queue = []; closeRoom(r.cfg.name); const nr = openRoom(c); if (nr) { nr.queue.push(...q); setTimeout(() => pump(nr), 50); } return;
    }
    r.send(sessionEvent(r));
    setTimeout(() => pump(r), 50);
  };
  child.on("close", onChildClose);
  // spawn() can fail asynchronously (ENOENT if claudeBin briefly vanished mid self-update, EACCES, …); with no
  // listener Node throws and kills the whole bridge, taking every other room down with it (2026-09-28 outage).
  child.on("error", err => { stderr += `\nspawn error: ${err.message}`; onChildClose(1); });
}
function pump(r) {
  if (r.running || r.closed) return;
  // a requested compaction runs before the next message; an automatic one waits for the queue to drain
  if (r.compactWanted && (r.compactWanted.startsWith("requested") || !r.queue.length)) { const why = r.compactWanted; r.compactWanted = null; compact(r, why); return; }
  if (!r.queue.length) return; const item = r.queue.shift(); saveQueue(r); runOne(r, item);
}

// spawn() never sets `detached`, so a child shares the bridge's own process group — killing that group would kill
// the bridge too. Walk the real tree with pgrep instead (exactly what killed 2026-10-08's stuck turn by hand): a
// `claude` subprocess that shells out (Bash tool) can leave grandchildren that don't die with their parent.
function killTree(pid, sig = "SIGTERM") {
  try { const kids = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean); for (const k of kids) killTree(k, sig); } catch {}
  try { process.kill(pid, sig); } catch {}
}
// Stuck-turn watchdog: nothing used to cap how long a single turn could run, so one could sit there past when
// anyone was watching and block every later message behind it (2026-10-08: a self-directed security audit ran
// 15+ minutes with no end in sight; Mike's own question sat queued the whole time with no indication why). A
// warning at 5 min costs nothing and gives the room a chance to self-explain; a kill at 10 min bounds the damage —
// the existing "non-scheduler crash: retry once, heavier" path in onChildClose picks it up from there same as any
// other crash, so this only needs to make the process actually end.
const TURN_WARN_MS = 5 * 60 * 1000, TURN_KILL_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    if (!r.child || !r.since) continue;
    const age = now - r.since;
    if (age > TURN_KILL_MS) {
      log(`#${r.cfg.name}`, "turn has run", Math.round(age / 60000) + "min — killing it (stuck-turn watchdog)");
      r.send({ type: "sys", text: `⚠️ This turn has been running ${Math.round(age / 60000)} minutes with no sign of finishing — stopping it so the room isn't blocked. It'll retry once automatically.`, ts: Date.now() });
      if (r.runningItem) r.runningItem.watchdogKilled = true; // so onChildClose retries it once, as the message above promises (code is null after a signal)
      killTree(r.child.pid);
    } else if (age > TURN_WARN_MS && !r.warnedStale) {
      r.warnedStale = true;
      r.send({ type: "sys", text: `This turn has been running ${Math.round(age / 60000)} minutes. Still working — /stop if you'd rather cancel it.`, ts: Date.now() });
    }
  }
}, 30000);

function openRoom(cfg) {
  if (!cfg || !cfg.name) { log("openRoom: invalid config", JSON.stringify(cfg).slice(0, 100)); return; }
  // Defense in depth: the worker now rejects a non-absolute cwd at creation time, but an older client, a direct API
  // call, or a room created before that check existed can still hand us one. A relative cwd resolves against THIS
  // process's own directory (jam's own source tree), silently mixing an unrelated project's files into it — that's
  // exactly how #familypod's research ended up inside jam/ (found and fixed 2026-09-29). Refuse rather than repeat it.
  if (!isAbsCwd(cfg.cwd)) { log(`#${cfg.name}`, "refusing relative/invalid cwd:", JSON.stringify(cfg.cwd)); const existingBad = rooms.get(cfg.name); if (existingBad) existingBad.send({ type: "sys", text: `⚠️ This room's directory ("${cfg.cwd}") isn't an absolute path, so the bridge won't run turns in it — fix it from room settings.`, ts: Date.now() }); return; }
  if (!bridgeOpensRoom(cfg.name, only)) return; // test-* rooms are for --only bridges; --only patterns support * glob
  const existing = rooms.get(cfg.name);
  if (existing) {
    if (existing.cfg.cwd !== cfg.cwd) {
      if (existing.child) { // never kill a running turn: switch directories once it finishes
        existing.pendingCfg = cfg; log(`#${cfg.name}`, "cwd →", cfg.cwd, "(after the current turn)");
        existing.send({ type: "sys", text: `Directory change to ${cfg.cwd} will apply when this turn finishes.`, ts: Date.now() }); return existing;
      }
      closeRoom(cfg.name);
    } else {
      if (!!existing.cfg.runLocal !== !!cfg.runLocal) { existing.cfg.runLocal = !!cfg.runLocal; log(`#${cfg.name}`, "run-commands-locally →", cfg.runLocal ? "ON for drivers" : "off"); existing.send({ type: "session", id: existing.sessionId, cwd: cfg.cwd, model: cfg.model, tier: cfg.tier, effort: cfg.effort, runLocal: !!cfg.runLocal }); }
      const modelChanged = existing.cfg.model !== cfg.model, tierChanged = existing.cfg.tier !== cfg.tier, effortChanged = existing.cfg.effort !== cfg.effort;
      if (modelChanged || tierChanged || effortChanged) {
        if (modelChanged) log(`#${cfg.name}`, "model →", cfg.model || "default");
        if (tierChanged) log(`#${cfg.name}`, "tier →", cfg.tier || "auto");
        if (effortChanged) log(`#${cfg.name}`, "effort →", cfg.effort || "auto");
        existing.cfg.model = cfg.model; existing.cfg.tier = cfg.tier; existing.cfg.effort = cfg.effort;
        existing.send(sessionEvent(existing));
      }
      return;
    }
  }
  mkdirSync(cfg.cwd, { recursive: true });
  const s = sessionFor(cfg);
  const q0 = loadQueue(cfg.name);
  const r = { cfg, ws: null, queue: q0, running: false, child: null, sessionId: s.id, fresh: s.fresh, closed: false, timer: null, seen: new Set(q0.map(x => x.id)), since: 0, lastTool: null, lastActivity: Date.now(), turnsSinceCompact: COMPACT_MIN_TURNS, lastCtx: s.ctx | 0, seed: null, compacting: false, compactWanted: null };
  r.hb = setInterval(() => {
    r.send({ type: "hb", running: !!r.child, current: r.current || null, since: r.since || null, lastTool: r.lastTool, task: r.currentTask || null, queue: r.queue.length });
    if (idleCompactDue(r, Date.now()))
      compact(r, `quiet for ${Math.round(COMPACT_IDLE_MS / 60000)} min with ${kfmt(r.lastCtx)} of context`);
  }, 10000);
  r.pendingOut = []; r.lastSendAt = 0;
  r.send = o => { // socket down? hold the event (except heartbeats, which go stale) and replay it in order on reconnect
    r.lastSendAt = Date.now();
    if (r.ws && r.ws.readyState === 1) { r.ws.send(JSON.stringify(o)); return; }
    if (o.type === "hb" || o.type === "catalog" || o.type === "usage") return; // live snapshots: a stale backlog is worse than the next refresh
    r.pendingOut.push(o); if (r.pendingOut.length > 5000) r.pendingOut.shift();
  };
  rooms.set(cfg.name, r);
  const connect = () => {
    if (r.closed) return;
    const ws = r.ws = new WebSocket(`wss://${host}/ws?room=${encodeURIComponent(cfg.name)}&k=${encodeURIComponent(key)}&role=bridge&name=bridge`);
    ws.onopen = () => { log(`#${cfg.name}`, "connected", "cwd", cfg.cwd, cfg.model ? "model " + cfg.model : ""); r.send(sessionEvent(r)); r.send({ type: "agents", list: agents }); if (lastUsage) r.send(lastUsage); r.send({ type: "colors", colors: userColors }); 
      // Always reassert known auth state on (re)connect, even "in": a room can be showing a stale "signed out" card
      // from before a bridge restart, and the old `!== "in"` guard here meant a healthy restart never corrected it —
      // only a room that already agreed nothing was wrong got told nothing (2026-09-29, Mike stuck on a stale card).
      if (authState) r.send({ type: "auth", ...authState });
      if (r.queue.length) setTimeout(() => pump(r), 50); /* turns reloaded from disk used to start only via the DO's outbox replay, which is now deduped away — wake them explicitly */ const schedForRoom = schedules.getForRoom(cfg.name); r.send({ type: "schedules", list: schedForRoom.map(s => ({ room: s.room, when: s.when, tier: s.tier || "auto", prompt: s.prompt })) }); r.send({ type: "sync", running: !!r.child, current: r.current || null, queue: r.queue.length }); if (r.pendingOut.length) { log(`#${cfg.name}`, "replaying", r.pendingOut.length, "events held while disconnected"); const held = r.pendingOut; r.pendingOut = []; for (const o of held) r.send(o); }  if (M.catalog) r.send(M.catalog); };
    ws.onmessage = ev => {
      // Same defense as the hub socket's handler below: a thrown error anywhere here propagates through
      // WebSocket's dispatchEvent and kills the WHOLE bridge, every room at once, not just this one — found
      // 2026-09-29 while writing the static guard for the hub handler and noticing this one had no such guard
      // at all, despite starting with the exact same unguarded JSON.parse.
      try {
      const m = JSON.parse(ev.data);
      if (m.type === "refresh") { refreshLive(false); return; }
      if (m.type === "upload") { handleUpload(r, m); return; }
      if (m.type === "unqueue") { const n = r.queue.length; r.queue = r.queue.filter(x => x.id !== m.id); r.seen.add(m.id); if (r.queue.length < n) { log(`#${cfg.name}`, "unqueued", String(m.id).slice(0, 8)); saveQueue(r); } return; }
      if (m.type === "browser-click") { handleBrowserClick(r, m); return; }
      if (m.type === "say") {
        // the room DO replays its outbox on every bridge reconnect; anything already on disk (loadQueue) or mid-run must not run twice
        if (isDuplicateSay(r, m)) return; rememberSay(r, m.id); r.lastActivity = Date.now();
        const hadColor = !!userColors[m.from]; assignColor(m.from); if (!hadColor && userColors[m.from]) r.send({ type: "colors", colors: { [m.from]: userColors[m.from] } }); // new user: tell the room now, not on the next reconnect
        if (isCompactCommand(m.text)) { r.compactWanted = "requested by " + m.from; r.compactFor = m.id; pump(r); return; }
        // a "no, ..." or "that's not it" shortly after a light/medium turn means the router undershot — feed it to
        // the nightly self-tuner (tune-router.mjs) so the thresholds correct without a code change.
        if (isRouterMiss(r.lastDone, m.text, Date.now())) {
          try { appendFileSync(path.join(stateDir, "misses.jsonl"), JSON.stringify({ ts: Date.now(), room: r.cfg.name, id: r.lastDone.id, tier: r.lastDone.tier }) + "\n"); } catch {}
          r.lastDone = null; // one miss per turn
        }
        r.queue.push(m); saveQueue(r); pump(r);
      }
      else if (m.type === "login") { startLogin(m.by); }                      // owner-only: the Worker never relays this from a driver or viewer
      else if (m.type === "login-code") { loginCode(m.code); }
      else if (m.type === "stop" && r.child) { log(`#${cfg.name}`, "stop by", m.by); r.stopped = true; setTimeout(() => r.stopped = false, 10000); r.child.kill("SIGINT"); const c = r.child; setTimeout(() => c && !c.killed && c.kill("SIGKILL"), 3000); }
      } catch (e) { log(`#${cfg.name}`, "room message error (ignored, bridge stays up):", e.message); }
    };
    ws.onclose = () => { if (!r.closed) { log(`#${cfg.name}`, "disconnected, retrying"); r.timer = setTimeout(connect, 3000); } };
    ws.onerror = e => { log(`#${cfg.name}`, "ws error", e.message || e.error?.code || e.error?.message || ""); };
  };
  connect(); return r;
}
/* ── browser clicks: run browser.mjs with click + screenshot, post result ── */
function handleBrowserClick(r, m) {
  const env = { ...process.env, JAM_HOST: host, JAM_KEY: key, JAM_ROOM: r.cfg.name, JAM_TURN: `click-${Date.now()}` };
  const steps = JSON.stringify([{ action: "click", x: m.x, y: m.y }, { action: "screenshot", caption: `Clicked (${m.x}, ${m.y})` }]);
  const ch = spawn("node", ["browser.mjs", steps], { cwd: here, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "", clickDone = false;
  ch.stderr.on("data", d => { stderr += d; });
  const onClickDone = code => {
    if (clickDone) return; clickDone = true;
    if (code !== 0) { log(`#${r.cfg.name}`, "browser-click failed:", stderr.slice(0, 200)); r.send({ type: "sys", text: "browser click failed; make sure the previous screenshot's browser is still open", ts: Date.now() }); }
  };
  ch.on("close", onClickDone);
  ch.on("error", err => { stderr += `\nspawn error: ${err.message}`; onClickDone(1); }); // see 2026-09-28 outage note above
}
/* ── uploads: chunked base64 over the room socket → ~/.jam/uploads/<room>/ ── */
const uploads = createUploads({ stateDir }); // chunk assembly and its bounds: uploads.mjs
function handleUpload(r, m) {
  const res = uploads.accept(r.cfg.name, m); if (!res) return;
  if (res.logLine) log(`#${r.cfg.name}`, ...res.logLine);
  r.send(res.reply);
}
setInterval(() => uploads.sweep(), 60000);

function closeRoom(name) {
  const r = rooms.get(name); if (!r) return;
  r.closed = true; clearTimeout(r.timer); clearInterval(r.hb); try { r.ws && r.ws.close(); } catch {} if (r.child) r.child.kill("SIGINT");
  rooms.delete(name); log(`#${name}`, "closed");
}

// A deleted test-* room leaves its queue, session, notes and handoffs behind. Only throwaway test-* names are purged (the test suites and
// QA agents own them). A rename arrives as remove+add, so renaming a test-* room drops its old state too; real rooms are never touched.
function purgeTestRoom(name) {
  if (!/^test-[\w-]+$/.test(name)) return;
  try { unlinkSync(queueFile(name)); } catch {}
  const dir = path.join(stateDir, "sessions");
  try { for (const f of readdirSync(dir)) if (f === name + ".json" || f === name + ".notes.md" || f.startsWith(name + "-handoff-") || f === name + ".seed.md") try { unlinkSync(path.join(dir, f)); } catch {}; } catch {}
  try { rmSync(path.join(stateDir, "uploads", name), { recursive: true, force: true }); rmSync(path.join(stateDir, "browser", name), { recursive: true, force: true }); } catch {}
  log(`#${name}`, "purged test room state");
}

/* ── hub: room registry ── */
function connectHub() {
  const ws = hubWs = new WebSocket(`wss://${host}/hub?k=${encodeURIComponent(key)}&role=bridge`);
  ws.onopen = () => { log("hub connected", host, only.length ? "only " + only.join(",") : ""); if (M.catalog) ws.send(JSON.stringify(M.catalog)); if (lastPlan) ws.send(JSON.stringify(lastPlan)); };
  ws.onmessage = ev => {
    // A thrown error anywhere in this handler propagates straight through the WebSocket's dispatchEvent and kills
    // the whole bridge (this is exactly how the 2026-09-28 outage happened) — belt and suspenders: every branch
    // below already guards its own shape, but a malformed frame (bad JSON, an unexpected m.type payload the hub
    // adds later) must never be fatal, so the whole handler runs under one catch too.
    try {
      const m = JSON.parse(ev.data);
      if (m.type === "rooms") { const names = new Set((m.rooms || []).filter(r => r && r.name).map(r => r.name)); for (const n of [...rooms.keys()]) if (!names.has(n)) closeRoom(n); for (const r of m.rooms || []) if (r && r.name) openRoom(r); }
      // m.room missing/malformed (bad hub payload, a rename mid-flight) used to throw inside openRoom's cfg.name
      // read, an unhandled error that crashed the whole bridge — every room down with it (2026-09-28 outage).
      else if (m.type === "room.change") { if (m.op === "remove") { if (m.room && m.room.name) { closeRoom(m.room.name); purgeTestRoom(m.room.name); } } else if (m.room && m.room.name) openRoom(m.room); }
      else if (m.type === "refresh") refreshLive(true); // lobby: no plan meters there, catalog only
    } catch (e) { log("hub message error (ignored, bridge stays up):", e.message); }
  };
  ws.onclose = () => { log("hub disconnected, retrying"); setTimeout(connectHub, 3000); };
  ws.onerror = e => log("hub ws error", e.message || e.error?.code || e.error?.message || "");
  setInterval(() => { try { ws.readyState === 1 && ws.send(JSON.stringify({ type: "ping" })); } catch {} }, 30000);
}
connectHub();
setInterval(refreshCatalog, 60 * 60 * 1000); refreshCatalog();
// a bridge that comes up logged out would otherwise fail every turn in a row before anyone knew why
{ const st0 = authStatus(); if (st0) { authState = { state: st0.loggedIn ? "in" : "out", email: st0.email, plan: st0.plan, why: "checked at startup", ts: Date.now() }; if (!st0.loggedIn) log("host auth: Claude Code is signed out on this machine"); } }

/* ── start scheduled turn checker: one tick just after every minute boundary. A fixed 60s interval drifts and, after the
   Mac sleeps, lands on a random second of a random minute; missed slots are caught up by Schedule.shouldRun. ── */
(function scheduleTick() {
  setTimeout(() => {
    try { checkScheduledTurns(); } catch (e) { log("scheduler tick error", e.message); }
    scheduleTick();
  }, 60000 - (Date.now() % 60000) + 250);
})();

/* ── self-restart when the bridge code changes (only under a supervisor such as launchd/systemd, i.e. ppid 1) ── */
if (process.ppid === 1 || process.env.JAM_AUTORESTART) {
  setInterval(pollUsage, USAGE_MS); pollUsage();
  const { watchFile } = await import("node:fs");
  const files = [fileURLToPath(import.meta.url), hookPath, ...["route.mjs", "catalog.mjs", "schedule.mjs", "tune-router.mjs", "budget.mjs", "sandbox.mjs", "turntext.mjs", "turn-events.mjs", "turn-policy.mjs", "models.mjs", "session-store.mjs", "compaction.mjs", "room-dispatch.mjs", "uploads.mjs", "schedule-cli.mjs", "sandbox/driver.sb", "sandbox/bashwrap.sh"].map(f => path.join(here, f))]; // static imports: a change needs a restart too
  let want = false, wantSince = 0;
  for (const f of files) watchFile(f, { interval: 5000 }, () => { if (!want) { log("code changed on disk — will restart when idle"); wantSince = Date.now(); } want = true; });
  // A stuck room (2026-10-08: a 15+ min turn) used to make this wait forever — a real fix sat undeployed in
  // production the whole time with nothing forcing the issue. The stuck-turn watchdog above now kills anything
  // past 10 min on its own, so this is mostly a backstop for other "never quite idle" cases (a draining socket,
  // a steady trickle of messages) — cap the wait instead of trusting "idle" to always eventually arrive.
  const MAX_RESTART_WAIT_MS = 12 * 60 * 1000;
  setInterval(() => { // restart once every room is idle AND its socket has drained what it just sent, or the cap hits
    if (!want) return;
    const overdue = Date.now() - wantSince > MAX_RESTART_WAIT_MS;
    if (!overdue) for (const r of rooms.values()) if (r.child || r.queue.length || r.pendingOut.length || (r.ws && r.ws.bufferedAmount > 0) || Date.now() - r.lastSendAt < 2000) return;
    log(overdue ? "restarting for new code — forced after waiting " + Math.round((Date.now() - wantSince) / 60000) + "min" : "restarting for new code");
    shutdown();
  }, 3000);
}
// A signal-driven shutdown (launchd restarting the job, a manual kill -TERM, Ctrl-C) is not the same as a driver
// clicking Stop, but closeRoom()'s child.kill("SIGINT") produces the same code:null the close handler treats as
// "stopped" — silently dropping whatever message was mid-flight with no error card and no retry (2026-09-29: two of
// Mike's live turns vanished this way when the bridge was restarted mid-turn). Put anything actually running back
// at the front of its queue, durably, before tearing anything down, so the next bridge start picks it right back up.
function shutdown() {
  for (const r of rooms.values()) {
    if (r.runningItem) {
      log(`#${r.cfg.name}`, "bridge shutting down mid-turn — requeuing", r.runningItem.id.slice(0, 8));
      r.queue.unshift(r.runningItem); r.runningItem = null; saveQueue(r);
    }
  }
  for (const n of [...rooms.keys()]) closeRoom(n);
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
