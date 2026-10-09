#!/usr/bin/env node
// browser.mjs — a persistent, room-visible headless browser for Claude to drive during a jam turn.
// Runs via Bash from inside a Claude turn (JAM_HOST/JAM_KEY/JAM_ROOM/JAM_TURN are already in its env,
// set by bridge.mjs when it spawns the turn — see runOne() in bridge.mjs). No bridge changes needed:
// this connects to the room worker as its own short-lived "bridge"-role socket (owner key = bridge
// role, see worker.src.js auth()) and posts a single `tool` card with an inline screenshot, which the
// DO already stores/broadcasts verbatim (tool/tool_result pass through unmodified).
//
// usage: node browser.mjs '<json-array-of-steps>' [--silent]
//   steps: [{action:"goto",url}, {action:"click",selector}, {action:"fill",selector,text},
//           {action:"press",selector,key}, {action:"wait",ms} or {action:"wait",selector},
//           {action:"eval",js}, {action:"text"}, {action:"screenshot",caption}]
// Cookies/localStorage persist per room across turns (profile dir below) so a login survives.
// In-page JS state does not survive between separate invocations — chain multi-step flows
// (fill several fields, submit) into one call's steps array rather than one call per field.
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const stateDir = path.join(os.homedir(), ".jam");
const room = process.env.JAM_ROOM || "jam";
const host = process.env.JAM_HOST || "";
const key = process.env.JAM_KEY || (existsSync(path.join(here, ".jam-key")) ? readFileSync(path.join(here, ".jam-key"), "utf8").trim() : "");
const turnId = process.env.JAM_TURN || ("browser-" + Date.now());
const silent = process.argv.includes("--silent");
const stepsArg = process.argv.slice(2).find(a => !a.startsWith("--"));

const roomDir = path.join(stateDir, "browser", room);
const profileDir = path.join(roomDir, "profile", turnId);  // per-turn isolation for concurrent safety
const stateFile = path.join(roomDir, "state.json");
const uploadDir = path.join(stateDir, "uploads", room);
mkdirSync(profileDir, { recursive: true });
mkdirSync(uploadDir, { recursive: true });

function loadState() { try { return JSON.parse(readFileSync(stateFile, "utf8")); } catch { return {}; } }
function saveState(s) { writeFileSync(stateFile, JSON.stringify(s)); }

function fail(msg) { console.error(msg); process.exit(1); }

let steps;
try { steps = JSON.parse(stepsArg || "[]"); } catch { fail("steps must be a JSON array, e.g. '[{\"action\":\"goto\",\"url\":\"https://example.com\"}]'"); }
if (!Array.isArray(steps) || !steps.length) fail("no steps given — see --help usage in this file's header comment");
if (!key) fail("no JAM_KEY in env — this must run inside a jam turn (Bash tool), not standalone");

/* ── post one card into the room, as a second short-lived bridge-role connection ──
   The DO treats every bridge-tagged socket the same way; it doesn't require this be THE bridge. */
function postCard({ summary, input, image, isError, text }) {
  return new Promise(resolve => {
    const callId = "browser-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const ws = new WebSocket(`wss://${host}/ws?room=${encodeURIComponent(room)}&k=${encodeURIComponent(key)}&role=bridge&name=bridge`);
    const done = () => { try { ws.close(); } catch {} resolve(); };
    const timer = setTimeout(done, 8000); // never hang a Claude turn on a flaky socket
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "tool", id: turnId, callId, name: "Browser", summary: String(summary).slice(0, 200), input: input || {}, image: image || null }));
      ws.send(JSON.stringify({ type: "tool_result", id: turnId, callId, is_error: !!isError, text: text || "" }));
      clearTimeout(timer); setTimeout(done, 300); // give the two sends a beat to flush before closing
    };
    ws.onerror = () => { clearTimeout(timer); done(); };
  });
}

/* ── live view: stream the page into the room while the steps run. CDP screencast frames → a "screen"-role socket (owner
   key; the Room fans them out to everyone and stores nothing) → the live panel over the transcript. ≤4 frames/s, latest
   frame wins when the socket is backed up. The final screenshot card still posts as before. Off with --silent. ── */
const cleanUrl = u => { try { const x = new URL(u); return x.origin === "null" ? u.slice(0, 80) : x.origin + x.pathname; } catch { return ""; } }; // never the query: owner links carry ?k=
const describe = s => s.action === "goto" ? "goto " + cleanUrl(s.url) : s.action === "click" ? "click " + (s.selector || `${s.x},${s.y}`) : s.action === "fill" || s.action === "type" ? "fill " + s.selector : s.action === "press" ? "press " + s.key : s.action === "wait" ? "wait " + (s.selector || (s.ms || 1000) + "ms") : s.action === "viewport" ? "viewport " + s.width : s.action; // no eval source or fill text: either can hold secrets
async function startLive(context, page) {
  if (silent || !host) return null;
  const sid = String(turnId).slice(0, 24) + "-" + Date.now().toString(36);
  const ws = new WebSocket(`wss://${host}/ws?room=${encodeURIComponent(room)}&k=${encodeURIComponent(key)}&role=screen`);
  const opened = await new Promise(res => { const t = setTimeout(() => res(false), 3000); ws.onopen = () => { clearTimeout(t); res(true); }; ws.onerror = () => { clearTimeout(t); res(false); }; });
  if (!opened) { try { ws.close(); } catch {} return null; }
  const L = { label: "", url: "", latest: null, last: 0, timer: null, cdp: null };
  L.flush = () => {
    if (L.timer) return;
    L.timer = setTimeout(() => {
      L.timer = null; if (ws.readyState !== 1) return;
      if ((ws.bufferedAmount | 0) > 400000) { L.flush(); return; }
      L.last = Date.now(); const data = L.latest; L.latest = null;
      try { ws.send(JSON.stringify({ type: "screen", sid, data, label: L.label, url: L.url })); } catch {}
    }, Math.max(0, 250 - (Date.now() - L.last)));
  };
  L.note = (label, url) => { L.label = label; if (url) L.url = cleanUrl(url); L.flush(); };
  try {
    L.cdp = await context.newCDPSession(page);
    L.cdp.on("Page.screencastFrame", f => { L.cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {}); L.latest = f.data; L.flush(); });
    await L.cdp.send("Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
  } catch {}
  L.stop = async () => {
    try { await L.cdp?.send("Page.stopScreencast"); } catch {}
    clearTimeout(L.timer);
    if (ws.readyState === 1) { try { ws.send(JSON.stringify({ type: "screen", sid, end: true })); } catch {} await new Promise(r => setTimeout(r, 250)); }
    try { ws.close(); } catch {}
  };
  return L;
}

const state = loadState();
const results = [];
let context, page, live = null;
try {
  context = await chromium.launchPersistentContext(profileDir, { headless: true, viewport: { width: 1280, height: 800 } });
  page = context.pages()[0] || await context.newPage();
  live = await startLive(context, page).catch(() => null);
  if (state.lastUrl && steps[0]?.action !== "goto") await page.goto(state.lastUrl, { waitUntil: "domcontentloaded" }).catch(() => {});

  for (const [i, step] of steps.entries()) {
    const { action } = step;
    live?.note(`step ${i + 1}/${steps.length} · ${describe(step)}`, action === "goto" ? step.url : page.url());
    if (action === "goto") { await page.goto(step.url, { waitUntil: "domcontentloaded", timeout: 20000 }); results.push({ action, url: step.url }); }
    else if (action === "click") {
      if (step.selector) { await page.click(step.selector, { timeout: 10000 }); results.push({ action, selector: step.selector }); }
      else if (step.x != null && step.y != null) { await page.mouse.click(step.x, step.y); results.push({ action, x: step.x, y: step.y }); }
      else results.push({ action, error: "click requires either selector or x,y coordinates" });
    }
    else if (action === "fill" || action === "type") { await page.fill(step.selector, String(step.text ?? ""), { timeout: 10000 }); results.push({ action, selector: step.selector }); }
    else if (action === "press") { await page.press(step.selector || "body", step.key, { timeout: 10000 }); results.push({ action, key: step.key }); }
    else if (action === "wait") { if (step.selector) await page.waitForSelector(step.selector, { timeout: step.timeout || 15000 }); else await page.waitForTimeout(step.ms || 1000); results.push({ action }); }
    else if (action === "eval") { const v = await page.evaluate(step.js); results.push({ action, value: typeof v === "string" ? v.slice(0, 4000) : v }); }
    else if (action === "viewport") { await page.setViewportSize({ width: step.width, height: step.height || 800 }); results.push({ action, width: step.width, height: step.height || 800 }); }
    else if (action === "text") { const t = await page.innerText("body").catch(() => ""); results.push({ action, text: t.slice(0, 4000) }); }
    else if (action === "screenshot") { results.push({ action, caption: step.caption || null }); } // captured below regardless
    else results.push({ action, error: "unknown action" });
  }

  const url = page.url(), title = await page.title().catch(() => "");
  state.lastUrl = url; saveState(state);

  let shotPath = null;
  if (!silent) {
    const buf = await page.screenshot({ type: "jpeg", quality: 70, fullPage: false });
    shotPath = path.join(uploadDir, `${Date.now()}-browser.jpg`);
    writeFileSync(shotPath, buf);
    const lastCaption = [...steps].reverse().find(s => s.action === "screenshot")?.caption;
    await postCard({ summary: lastCaption || title || url, input: { url }, image: "data:image/jpeg;base64," + buf.toString("base64") });
  }

  console.log(JSON.stringify({ ok: true, url, title, results, screenshot: shotPath }, null, 1));
} catch (e) {
  if (!silent) await postCard({ summary: "error: " + e.message.split("\n")[0].slice(0, 150), isError: true, text: e.message });
  console.log(JSON.stringify({ ok: false, error: e.message, results }, null, 1));
  process.exitCode = 1;
} finally {
  if (live) await live.stop().catch(() => {});
  if (context) await context.close().catch(() => {});
}
