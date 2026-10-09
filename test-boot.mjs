#!/usr/bin/env node
// Regression: owner can boot a driver/viewer from a room; the revoked token is dead everywhere;
// presence frames never leak tokens to non-owner sockets (only owner sees who-to-boot).
// Needs: a deployed Worker, a bridge serving the test room, Playwright, an owner key (K).
//   K=<owner key> JAM_HOST=<host> node test-boot.mjs
import { httpBase, wsBase, DEFAULT_HOST } from "./jam-url.mjs";
import { chromium } from "playwright";

const K = process.env.K, H = process.env.JAM_HOST || DEFAULT_HOST, ROOM = process.env.ROOM || "test-qa-boot-feature";
let fail = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };

async function mkInvite(role, name) {
  const r = await fetch(`${httpBase(H)}/api/rooms/${ROOM}/invites?k=${K}`, { method: "POST", body: JSON.stringify({ role, name }) }).then(r => r.json());
  if (!r.ok) throw new Error("invite failed: " + JSON.stringify(r));
  return r.token;
}

const driverTok = await mkInvite("driver", "Driver1");
const driver2Tok = await mkInvite("driver", "Driver2");
const viewerTok = await mkInvite("viewer", "Viewer1");

const b = await chromium.launch({ args: ["--mute-audio"] });

// each context gets a wrapped WebSocket that logs every inbound frame (parsed) and every close event,
// so the test can inspect exactly what the server put on the wire — not just what the UI rendered.
async function frameCtx(name) {
  const ctx = await b.newContext({ viewport: { width: 1100, height: 700 } });
  await ctx.addInitScript(who => {
    localStorage.setItem("jam.name", who);
    window.__frames = []; window.__closes = [];
    const W = window.WebSocket;
    window.WebSocket = class extends W {
      constructor(...a) {
        super(...a);
        this.addEventListener("message", e => { try { window.__frames.push(JSON.parse(e.data)); } catch {} });
        this.addEventListener("close", e => { window.__closes.push({ code: e.code, reason: e.reason }); });
      }
    };
  }, name);
  const p = await ctx.newPage();
  return { ctx, p };
}

const owner = await frameCtx("Owner");
const driver = await frameCtx("Driver1");
const driver2 = await frameCtx("Driver2");
const viewer = await frameCtx("Viewer1");

await owner.p.goto(`${httpBase(H)}/r/${ROOM}?k=${K}`);
await owner.p.waitForTimeout(1200);
await driver.p.goto(`${httpBase(H)}/j/${driverTok}`);
await driver2.p.goto(`${httpBase(H)}/j/${driver2Tok}`);
await viewer.p.goto(`${httpBase(H)}/j/${viewerTok}`);
await owner.p.waitForTimeout(2500); // let everyone join + presence settle

/* ── step 3: presence isolation ── */
const ownerPresence = await owner.p.evaluate(() => window.__frames.filter(f => f.type === "presence").at(-1));
const driverPresence = await driver.p.evaluate(() => window.__frames.filter(f => f.type === "presence").at(-1));
const viewerPresence = await viewer.p.evaluate(() => window.__frames.filter(f => f.type === "presence").at(-1));

ok(!!ownerPresence && ownerPresence.users.length >= 4, "owner received a presence frame with all 4 connected users — worker.src.js:189-194");
const ownerHasTokens = ownerPresence && ownerPresence.users.every(u => "token" in u && typeof u.token === "string");
ok(ownerHasTokens, "owner's presence frame includes a token field on every user — worker.src.js:192 (isOwner branch)");

ok(!!driverPresence, "driver received a presence frame");
const driverLeaksTokens = driverPresence && driverPresence.users.some(u => "token" in u);
ok(!driverLeaksTokens, "driver's presence frame has NO token field on any user — worker.src.js:192 (non-owner branch)");
const driverFrameShape = driverPresence && driverPresence.users.every(u => Object.keys(u).sort().join(",") === "name,role");
ok(driverFrameShape, "driver's presence users are exactly {name, role} — no extra fields");

ok(!!viewerPresence, "viewer received a presence frame");
const viewerLeaksTokens = viewerPresence && viewerPresence.users.some(u => "token" in u);
ok(!viewerLeaksTokens, "viewer's presence frame has NO token field on any user — worker.src.js:192 (non-owner branch)");

/* ── step 4: UI — who sees the "-" (kick) button ── */
const ownerKickTargets = await owner.p.evaluate(() => [...document.querySelectorAll(".person")].filter(p => p.querySelector(".kick")).map(p => p.querySelector(".nm").textContent));
ok(ownerKickTargets.includes("Driver1") && ownerKickTargets.includes("Driver2") && ownerKickTargets.includes("Viewer1"),
  `owner sees "-" next to every other person (got: ${JSON.stringify(ownerKickTargets)}) — ui.html:341`);
const ownerSeesOwnKick = await owner.p.evaluate(() => { const rows = [...document.querySelectorAll(".person")]; const mine = rows.find(r => r.querySelector(".badge")?.textContent === "owner"); return !!mine?.querySelector(".kick"); });
ok(!ownerSeesOwnKick, "owner does NOT see a \"-\" button next to their own row — ui.html:341 p.name!==name guard");

const driverSeesAnyKick = await driver.p.evaluate(() => document.querySelectorAll(".kick").length);
ok(driverSeesAnyKick === 0, `driver sees NO "-" buttons at all (got ${driverSeesAnyKick}) — gated by isOwner in ui.html:341, backstopped by token-free presence frame`);

const driver2SeesAnyKick = await driver2.p.evaluate(() => document.querySelectorAll(".kick").length);
ok(driver2SeesAnyKick === 0, `other driver (Driver2) sees NO "-" button for Driver1 (got ${driver2SeesAnyKick}) — ui.html:341`);

const viewerSeesAnyKick = await viewer.p.evaluate(() => document.querySelectorAll(".kick").length);
ok(viewerSeesAnyKick === 0, `viewer sees NO "-" buttons at all (got ${viewerSeesAnyKick}) — ui.html:341`);

/* ── step 2 (cancel path first): dialog cancel does nothing ── */
let dialogMsg = null;
owner.p.once("dialog", async d => { dialogMsg = d.message(); await d.dismiss(); });
const driverRow = () => owner.p.locator(".person").filter({ hasText: "Driver1" });
await driverRow().locator(".kick").click();
await owner.p.waitForTimeout(800);
ok(dialogMsg === "Boot Driver1 from the room?\n\nThey won't be able to rejoin with their current link.",
  `confirm dialog text exact match (got: ${JSON.stringify(dialogMsg)}) — ui.html:341`);
const driverStillOpenAfterCancel = await driver.p.evaluate(() => window.__closes.length === 0);
ok(driverStillOpenAfterCancel, "cancelling the confirm dialog did nothing — Driver1's socket is still open, no close event fired");
const resolveAfterCancel = await fetch(`${httpBase(H)}/hub`).catch(() => null); // no-op sanity, real check below
const stillResolves = await fetch(`${httpBase(H)}/`).then(() => true).catch(() => false); // liveness only
const resolveStillOk = await (await fetch(`${httpBase(H)}/api/whoami?k=${driverTok}`)).json();
ok(resolveStillOk.ok, "token still resolves after a cancelled boot (not revoked)");

/* ── step 2 (real boot): confirm path ── */
dialogMsg = null;
owner.p.once("dialog", async d => { dialogMsg = d.message(); await d.accept(); });
const revokeReq = owner.p.waitForResponse(r => r.url().includes("/api/revoke/" + driverTok), { timeout: 8000 });
await driverRow().locator(".kick").click();
const revokeResp = await revokeReq.catch(() => null);
ok(!!revokeResp && revokeResp.ok(), `accepting the boot dialog fired POST /api/revoke/${driverTok} and it returned 200 — worker.src.js:119-124 -> ui.html:341`);

const kickedFrame = await driver.p.waitForFunction(() => window.__frames.some(f => f.type === "kicked"), null, { timeout: 8000 }).then(() => true).catch(() => false);
ok(kickedFrame, "Driver1's socket received a {type:\"kicked\"} frame — worker.src.js:279");

const closedRight = await driver.p.waitForFunction(() => window.__closes.length > 0, null, { timeout: 8000 }).then(() => true).catch(() => false);
const closeCode = closedRight ? await driver.p.evaluate(() => window.__closes[0].code) : null;
ok(closeCode === 4001, `Driver1's websocket closed with code 4001 (got ${closeCode}) — worker.src.js:279 ws.close(4001,"revoked")`);

const kickedScreen = await driver.p.waitForSelector("text=Access revoked", { timeout: 5000 }).then(() => true).catch(() => false);
ok(kickedScreen, "driver's tab shows the \"Access revoked\" overlay — ui.html:391");

/* ── other people were NOT affected by Driver1's boot ── */
const driver2StillUp = await driver2.p.evaluate(() => window.__closes.length === 0);
ok(driver2StillUp, "Driver2's socket was untouched by Driver1's boot");
const viewerStillUp = await viewer.p.evaluate(() => window.__closes.length === 0);
ok(viewerStillUp, "Viewer1's socket was untouched by Driver1's boot");

/* ── KNOWN ESCAPE (2026-09-10, Olga): the People panel does not refresh after a boot ──
   Root cause: Room's "/kick" handler (worker.src.js:277-280) calls this.presence() synchronously
   right after ws.close(4001,...), but the closed socket is still in state.getWebSockets("user") at
   that instant, so the broadcast still includes the booted user. The only other place presence()
   re-runs is webSocketClose (worker.src.js:377-384) — but that hook does not fire for this
   server-initiated close (confirmed: 30s with no self-correction), and — worse — it does not
   reliably fire promptly for an ordinary client-side tab close either (same 30s non-refresh
   reproduced with a ws never touched by /kick). So EVERY connected client (owner included) keeps
   showing a departed user, with the owner's live "-" button still sitting there, until some
   unrelated join/leave elsewhere in the room forces a fresh presence() call. This is not unique to
   boot, but boot is where it's most damaging: the one signal a board member needs — "did the boot
   actually work?" — visibly says no when it didn't. Expected: the booted row disappears from every
   connected client within a couple seconds of the boot, with no other join/leave required. */
await driver2.p.waitForTimeout(8000); // generous — production observed no self-correction inside 30s
const staleOnOwner = await owner.p.locator(".person .nm").allTextContents();
ok(!staleOnOwner.includes("Driver1"), `KNOWN BUG — owner's People panel should drop Driver1 within ~8s of the boot with no other join/leave (got: ${JSON.stringify(staleOnOwner)}) — worker.src.js:280 presence() runs before the close completes, and worker.src.js:377-384 webSocketClose does not reliably fire to refresh it`);
const staleOnBystander = await driver2.p.locator(".person .nm").allTextContents();
ok(!staleOnBystander.includes("Driver1"), `KNOWN BUG — Driver2 (uninvolved bystander)'s People panel should also drop Driver1 within ~8s (got: ${JSON.stringify(staleOnBystander)}) — same root cause, confirms this is a presence broadcast bug, not owner-UI-only`);

/* ── step 5: token revocation is real, not just a UI close ── */
const resolveAfterBoot = await fetch(`${httpBase(H)}/api/whoami?k=${driverTok}`).then(r => r.json());
ok(resolveAfterBoot.ok === false, `owner-scoped whoami for the revoked token now fails (got ${JSON.stringify(resolveAfterBoot)}) — worker.src.js:48 this.revoked[tok]`);

// hit the Hub's /resolve directly is internal-only (DO-to-DO), so we prove revocation the way any real client would:
// re-navigate to the same /j/ link and confirm the "Link not valid" screen renders, no rejoin possible.
await driver.p.goto(`${httpBase(H)}/j/${driverTok}`);
const linkInvalid = await driver.p.waitForSelector("text=Link not valid", { timeout: 8000 }).then(() => true).catch(() => false);
ok(linkInvalid, "re-visiting the revoked /j/ link shows \"Link not valid\" — cannot rejoin with the old token");

// and prove the raw socket path is dead too: try to open a new /ws with the revoked token directly.
const wsRejected = await driver.p.evaluate(async ({ host, tok, room }) => {
  return await new Promise(resolve => {
    const ws = new WebSocket(`${wsBase(host)}/ws?k=${encodeURIComponent(tok)}&room=${encodeURIComponent(room)}&name=Driver1Retry`);
    const timer = setTimeout(() => resolve("timeout"), 6000);
    ws.onopen = () => { clearTimeout(timer); resolve("opened"); };
    ws.onerror = () => { clearTimeout(timer); resolve("error"); };
    ws.onclose = ev => { clearTimeout(timer); resolve("closed:" + ev.code); };
  });
}, { host: H, tok: driverTok, room: ROOM });
ok(wsRejected !== "opened", `a raw /ws connect attempt with the revoked token does not open a working socket (got: ${wsRejected}) — worker.src.js: auth() -> /resolve 404 -> "/ws" returns 403`);

await b.close();
console.log(fail ? `\n${fail} boot/revocation FAILURES` : "\nboot/revocation: all cases pass");
process.exit(fail ? 1 : 0);
