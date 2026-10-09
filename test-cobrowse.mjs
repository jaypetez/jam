#!/usr/bin/env node
// Regression: co-browsing. Clicking a Browser screenshot as the owner makes the bridge replay the click on the
// room's last page (browser.mjs click + screenshot) and post a new card showing the result. Viewers can't click,
// neither through the UI nor by sending browser-click over their own socket.
// No Claude turn: the first card is posted by running browser.mjs directly into the test room.
// Needs: a deployed Worker, a bridge serving ROOM (run-tests.sh), Playwright, an owner key (K).
//   K=<owner key> JAM_HOST=<host> ROOM=test-cobrowse node test-cobrowse.mjs
import { chromium } from "playwright";
import { spawnSync } from "node:child_process";

const K = process.env.K, H = process.env.JAM_HOST || "jam.nullagency.io", ROOM = process.env.ROOM || "test-cobrowse";
let fail = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };

// White until clicked anywhere, then red. The screenshot after the click shows whether the click actually
// reached the page, not just whether a card got posted. (Hash navigation doesn't work on data: URLs.)
const PAGE = "data:text/html," + encodeURIComponent(`<title>cobrowse</title><button style="position:fixed;inset:0;border:0;background:#fff;font-size:40px" onclick="this.style.background='#f00'">click anywhere</button>`);

/* ── seed: one screenshot card, posted the same way a turn's Browser call posts it ── */
const seed = spawnSync(process.execPath, ["browser.mjs", JSON.stringify([{ action: "goto", url: PAGE }, { action: "screenshot", caption: "cobrowse seed" }])],
  { env: { ...process.env, JAM_HOST: H, JAM_KEY: K, JAM_ROOM: ROOM, JAM_TURN: "cobrowse-seed" }, encoding: "utf8", timeout: 60000 });
ok(seed.status === 0, "browser.mjs posted the seed screenshot card" + (seed.status ? ": " + String(seed.stderr).slice(0, 200) : ""));

const b = await chromium.launch({ args: ["--mute-audio"] });
async function open(url, who) {
  const ctx = await b.newContext({ viewport: { width: 1100, height: 800 } });
  await ctx.addInitScript(n => localStorage.setItem("jam.name", n), who);
  const p = await ctx.newPage(); await p.goto(url);
  await p.waitForSelector(".tool img", { timeout: 20000 }).catch(() => {});
  return p;
}
const count = p => p.evaluate(() => document.querySelectorAll(".tool img").length);
// colour at (20,20) of the newest screenshot, read through a canvas (data: URLs don't taint it)
const px = p => p.evaluate(async () => {
  const all = document.querySelectorAll(".tool img"); const el = all[all.length - 1]; if (!el) return null;
  const im = new Image(); im.src = el.src; await im.decode();
  const c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight;
  const x = c.getContext("2d"); x.drawImage(im, 0, 0); return [...x.getImageData(20, 20, 1, 1).data].slice(0, 3);
});
const isRed = c => !!c && c[0] > 200 && c[1] < 80 && c[2] < 80;
const isWhite = c => !!c && c[0] > 220 && c[1] > 220 && c[2] > 220;
const dotShown = p => p.evaluate(() => [...document.querySelectorAll(".tool div")].some(d => d.style.background === "red" && d.style.display === "block"));
async function clickNewest(p) {
  const img = p.locator(".tool img").last(); await img.scrollIntoViewIfNeeded(); await p.waitForTimeout(200);
  const bx = await img.boundingBox(); if (!bx) return false;
  await p.mouse.click(bx.x + bx.width / 2, bx.y + bx.height / 2); return true;
}
async function grew(p, from, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (await count(p) > from) return true; await p.waitForTimeout(1000); } return false; }

const owner = await open(`https://${H}/r/${ROOM}?k=${K}`, "Owner");
const n0 = await count(owner);
ok(n0 >= 1, `owner sees the seed screenshot (${n0} image card)`);
ok(isWhite(await px(owner)), "seed screenshot shows the unclicked (white) page");

/* ── viewers cannot drive: UI click is ignored, and a hand-sent browser-click is dropped by the Worker ── */
const inv = await fetch(`https://${H}/api/rooms/${ROOM}/invites?k=${K}`, { method: "POST", body: JSON.stringify({ role: "viewer", name: "Viewer1" }) }).then(r => r.json());
ok(inv.ok && inv.token, "viewer invite minted");
const viewer = await open(`https://${H}/j/${inv.token}`, "Viewer1");
ok(await clickNewest(viewer), "viewer can see and click the screenshot");
ok(!(await dotShown(viewer)), "viewer's click draws no red dot (ui.html canDrive guard)");
const ws = new WebSocket(`wss://${H}/ws?room=${encodeURIComponent(ROOM)}&k=${encodeURIComponent(inv.token)}&name=Viewer1`);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; setTimeout(() => rej(new Error("ws timeout")), 10000); }).catch(e => ok(false, "viewer socket opened: " + e.message));
ws.send(JSON.stringify({ type: "browser-click", x: 640, y: 400, callId: "forged" }));
ok(!(await grew(owner, n0, 10000)), "no new card after the viewer's UI click and forged browser-click (worker.src.js canDrive gate)");
ws.close();

/* ── owner click → bridge replays it on the last page → new card, and the page really got clicked ── */
const n1 = await count(owner);
ok(await clickNewest(owner), "owner clicked the screenshot");
ok(await dotShown(owner), "owner's click drops a red dot where they clicked");
ok(await grew(owner, n1, 45000), "a new screenshot card arrives after the owner's click (bridge.mjs handleBrowserClick)");
const cap = await owner.evaluate(() => { const t = [...document.querySelectorAll(".tool")].filter(t => t.querySelector("img")).at(-1); return t?.querySelector(".hd .s")?.textContent || ""; });
ok(cap.startsWith("Clicked ("), `new card is captioned as the click (got: ${JSON.stringify(cap.slice(0, 40))})`);
ok(isRed(await px(owner)), "new screenshot shows the clicked (red) page: the click reached the restored page");

await b.close();
console.log(fail ? `cobrowse: ${fail} FAIL` : "cobrowse: all passed");
process.exit(fail ? 1 : 0);
