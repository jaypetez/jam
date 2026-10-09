#!/usr/bin/env node
// Regression: the status bar (topAct) must never render a raw tool command, an absolute host path, or a raw
// JSON fragment — only the sanitized TOOL_LABEL (e.g. "Running a command"). test-status-bar.mjs only ever
// inspects the finished done/say text in /api/history; it never looks at the live topAct DOM while a turn is
// running, so it could not have caught the 2026-09-10 leak where ui.html rendered `e.name+" "+e.summary`
// (the raw Bash command/path) straight into the status bar for the whole duration of a tool call. This test
// drives a real turn with a Bash tool call and watches topAct via a MutationObserver for the entire turn.
//   K=<owner key> JAM_HOST=<host> ROOM=<room> node test-statusbar-live.mjs
// Needs: a deployed/served Worker + a bridge serving ROOM (run-tests.sh does this), Playwright.
import { httpBase, DEFAULT_HOST } from "./jam-url.mjs";
import { chromium } from "playwright";

const K = process.env.K, H = process.env.JAM_HOST || DEFAULT_HOST, ROOM = process.env.ROOM || "test-qa-browser";
const INSECURE = process.env.JAM_INSECURE_TLS === "1"; // set for a local https:// dev server with a self-signed cert (a plain-http local stack needs nothing: see jam-url.mjs)
let fail = 0; const ok = (c, m, extra = "") => { console.log((c ? "PASS " : "FAIL ") + m, extra); if (!c) fail++; };

// Anything matching these should NEVER appear in the status bar (topAct) — raw command text, absolute host
// paths, or a raw JSON step array — only a sanitized label (e.g. "Running a command") belongs there.
const RAW_PATTERNS = [
  /\/Users\/[\w.\-/]+/,          // absolute filesystem path
  /\bsleep\s+\d/,                 // raw shell command fragment
  /\bnode\s+browser\.mjs/,        // raw shell command fragment
  /\{"action"/,                   // raw JSON step fragment
  /^\s*\$\s+/,                    // shell-prompt-style raw command
];

const b = await chromium.launch({ args: ["--mute-audio"] });
const ctx = await b.newContext({ viewport: { width: 1100, height: 700 }, ignoreHTTPSErrors: INSECURE });
await ctx.addInitScript(() => { localStorage.setItem("jam.name", "Olga"); window.__hellos = 0;
  const W = window.WebSocket; window.WebSocket = class extends W { constructor(...a) { super(...a); this.addEventListener("message", e => { try { if (this.url.includes("/ws?") && JSON.parse(e.data).type === "hello") window.__hellos++; } catch {} }); } };
});
const p = await ctx.newPage();
await p.goto(`${httpBase(H)}/r/${ROOM}?k=${K}`); // the scheme comes from jam-url.mjs (https for real hosts, http for a loopback dev stack); INSECURE (above) only affects cert trust
await p.waitForSelector("textarea", { timeout: 20000 });
await p.waitForFunction(() => window.__hellos >= 1, null, { timeout: 30000 }); // the socket is really open — a fixed delay raced it under load
await p.waitForTimeout(250);

// Arm the watcher on topAct BEFORE sending anything, so we can't miss the very first mutation.
await p.evaluate(() => {
  window.__topActLog = [];
  const el = document.querySelector(".topAct");
  if (!el) { window.__topActLog.push("NO_TOPACT_ELEMENT"); return; }
  const record = () => { const t = el.textContent || ""; if (t) window.__topActLog.push(t); };
  new MutationObserver(record).observe(el, { childList: true, subtree: true, characterData: true });
});

// The exact repro: a Bash tool call whose raw command contains a path-shaped script invocation and a raw
// JSON array — exactly the shape that used to leak into the status bar verbatim.
const cmd = `sleep 4 && node browser.mjs '[{"action":"goto","url":"https://example.com"},{"action":"screenshot","caption":"regression check"}]'`;
await p.fill("textarea", `Use the Bash tool exactly once to run this exact command verbatim (do not use TodoWrite for this, just run it): ${cmd}\nThen reply in one short sentence with what happened.`);
await p.keyboard.press("Enter");

const started = await p.waitForFunction(() => {
  const pill = document.querySelector("header.top .pill");
  return pill && /working/i.test(pill.textContent || "");
}, null, { timeout: 30000 }).then(() => true).catch(() => false);
ok(started, "turn started (status pill shows working)");

const finished = await p.waitForFunction(() => {
  const pill = document.querySelector("header.top .pill");
  return pill && /idle/i.test(pill.textContent || "");
}, null, { timeout: 120000 }).then(() => true).catch(() => false);
ok(finished, "turn completed (status pill back to idle)");

const log = await p.evaluate(() => window.__topActLog || []);
ok(log.length > 0 && log[0] !== "NO_TOPACT_ELEMENT", `topAct observed live during the turn (${log.length} mutations captured)`);

let leak = null;
for (const text of log) {
  for (const pat of RAW_PATTERNS) {
    if (pat.test(text)) { leak = { text, pat: pat.source }; break; }
  }
  if (leak) break;
}
ok(!leak, "topAct never showed a raw command/path/JSON at any point during the turn", leak ? `— leaked: "${leak.text.slice(0, 160)}" matched /${leak.pat}/` : "");

await b.close();
console.log(fail ? `\n${fail} statusbar-live FAILURES` : "\nstatusbar-live: all cases pass");
process.exit(fail ? 1 : 0);
