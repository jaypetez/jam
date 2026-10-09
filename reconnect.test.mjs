#!/usr/bin/env node
// Regression: a browser that loses its socket in the middle of a streaming reply must still show the reply.
// Needs: a deployed Worker, a bridge serving the test room (run-tests.sh does this), Playwright.
//   K=<owner key> JAM_HOST=<host> node reconnect.test.mjs
import { httpBase, DEFAULT_HOST } from "./jam-url.mjs";
import { chromium } from "playwright";

const K = process.env.K, H = process.env.JAM_HOST || DEFAULT_HOST, ROOM = process.env.ROOM || "test-reconnect";
let fail = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };

const b = await chromium.launch({ args: ["--mute-audio"] });
const ctx = await b.newContext({ viewport: { width: 1100, height: 700 } });
await ctx.addInitScript(() => { // expose the room socket so the test can kill it, and count hellos to prove a reconnect happened
  localStorage.setItem("jam.name", "Tester"); window.__hellos = 0; window.__socks = [];
  const W = window.WebSocket; window.WebSocket = class extends W { constructor(...a) { super(...a); window.__socks.push(this); this.addEventListener("message", e => { try { if (this.url.includes("/ws?") && JSON.parse(e.data).type === "hello") window.__hellos++; } catch {} }); } };
});
const p = await ctx.newPage();
await p.goto(`${httpBase(H)}/r/${ROOM}?k=${K}`);
// Wait for the room socket's first hello, not a fixed delay: send() is a no-op while
// ws.readyState!==1, so under full-suite load a 2500ms guess dropped the message and no
// turn ever reached the bridge (flaked 3x on 2026-09-11, passed in isolation every time).
await p.waitForFunction(() => window.__hellos >= 1, null, { timeout: 30000 });
await p.waitForTimeout(250);

// a reply long enough to still be streaming when we pull the plug
await p.fill("textarea", "Write the numbers 1 to 400, one per line, no commentary, no code block.");
await p.keyboard.press("Enter");
const started = await p.waitForSelector(".msg.ai .body.cursor", { timeout: 60000 }).then(() => true).catch(() => false);
ok(started, "reply started streaming");

// drop the socket mid-stream from the server side — the same thing a recycled Durable Object (e.g. a deploy) does to every tab
const dropped = await fetch(`${httpBase(H)}/api/rooms/${ROOM}/drop?k=${K}`, { method: "POST" }).then(r => r.json()).catch(() => ({}));
ok(dropped.ok, `server dropped ${dropped.closed} browser socket(s) mid-stream`);
const reconnected = await p.waitForFunction(() => window.__hellos >= 2, null, { timeout: 20000 }).then(() => true).catch(() => false);
ok(reconnected, "socket dropped and the page reconnected (second hello received)");
// the whole point: the socket came back while the reply was still streaming (otherwise this test proved nothing)
const midStream = await p.evaluate(() => !!document.querySelector(".msg.ai .body.cursor"));
ok(midStream, "reconnected while the reply was still streaming (a real mid-turn drop)");

// wait for the turn to finish, then the reply must be on the page in full
const finished = await p.waitForFunction(() => !document.querySelector(".msg.ai .body.cursor") && document.querySelectorAll(".msg.ai").length > 0, null, { timeout: 90000 }).then(() => true).catch(() => false);
ok(finished, "turn finished after the reconnect");
const text = await p.evaluate(() => { const all = [...document.querySelectorAll(".msg.ai .body")]; return (all.at(-1)?.innerText || "").trim(); });
ok(/\b399\b[\s\S]*\b400\b/.test(text), "final reply visible and complete after the reconnect (ends with 399, 400)");
ok(!/(\b400\b[\s\S]*){2}/.test(text), "reply not duplicated");
const bubbles = await p.evaluate(() => document.querySelectorAll(".msg.ai").length);
ok(bubbles === 1, `exactly one reply bubble (got ${bubbles})`);

await b.close();
console.log(fail ? `\n${fail} reconnect FAILURES` : "\nreconnect: all cases pass");
process.exit(fail ? 1 : 0);
