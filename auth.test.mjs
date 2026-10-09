#!/usr/bin/env node
// e2e: the host machine's Claude Code login is fixable from inside the room.
//   1. a bridge that starts signed out tells the owner so, and only the owner;
//   2. the owner starting a sign-in gets the real URL the CLI prints;
//   3. the code typed in the room reaches the waiting process and flips the state to signed in;
//   4. a driver can neither start a sign-in nor push a code at one.
// Run against a bridge started with the stub CLI (run-tests.sh does this):
//   JAM_ONLY=test-auth JAM_CLAUDE=<repo>/test-auth-claude-stub.mjs JAM_AUTH_STATE=/tmp/jam-auth-state.json \
//   JAM_AUTH_GOOD_CODE=good-code JAM_CATALOG=off node bridge.mjs
//   K=<owner key> JAM_HOST=<host> ROOM=test-auth node auth.test.mjs
import { httpBase, wsBase, DEFAULT_HOST } from "./jam-url.mjs";
const K = process.env.K, H = process.env.JAM_HOST || DEFAULT_HOST, ROOM = process.env.ROOM || "test-auth";
const GOOD = process.env.JAM_AUTH_GOOD_CODE || "good-code";
let fail = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };
const sock = async (q) => { const w = new WebSocket(`${wsBase(H)}/ws?${q}`); await new Promise((res, rej) => { w.onopen = () => res(); w.onerror = () => rej(new Error("ws error")); }); const evs = []; w.onmessage = ev => evs.push(JSON.parse(ev.data)); w.evs = evs; return w; };
const waitFor = (evs, pred, ms) => new Promise(res => { const t0 = Date.now(); const iv = setInterval(() => { const hit = evs.find(pred); if (hit || Date.now() - t0 > ms) { clearInterval(iv); res(hit || null); } }, 200); });

// an invite for the driver half of the test
const inv = await (await fetch(`${httpBase(H)}/api/rooms/${ROOM}/invites?k=${K}`, { method: "POST", body: JSON.stringify({ role: "driver", name: "Driver1" }) })).json();
const tok = inv.invite?.token || inv.token;

const owner = await sock(`room=${ROOM}&k=${K}&name=Mike`);
const driver = await sock(`k=${tok}&name=Driver1`);

// 1. the signed-out bridge says so, unprompted, to the owner only — as a live frame if the tab was already open,
// or in hello if it opened later (the Worker keeps the last state for exactly this reason)
const out = await waitFor(owner.evs, e => (e.type === "auth" && e.state === "out") || (e.type === "hello" && e.auth?.state === "out"), 20000);
ok(!!out, "owner is told the host is signed out: " + (out ? (out.why || out.auth?.why) : "nothing in 20s"));
ok(!driver.evs.some(e => e.type === "auth"), "driver never sees the auth state (" + driver.evs.filter(e => e.type === "auth").length + " frames)");

// 2. a driver cannot start a sign-in, or feed a code to one
driver.send(JSON.stringify({ type: "login" }));
driver.send(JSON.stringify({ type: "login-code", code: GOOD }));
await new Promise(r => setTimeout(r, 3000));
ok(!driver.evs.some(e => e.type === "auth" && e.state !== "out"), "driver's login attempt is dropped by the worker");
ok(!owner.evs.some(e => e.type === "auth" && (e.state === "starting" || e.state === "url")), "the driver's attempt didn't start a flow behind the owner's back");

// 3. the owner starts it and gets the URL the CLI printed
let mark = owner.evs.length;
owner.send(JSON.stringify({ type: "login" }));
const url = await waitFor(owner.evs, e => e.type === "auth" && e.state === "url", 20000);
ok(url && /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/.test(url.url || ""), "the sign-in URL reaches the room: " + (url?.url?.slice(0, 48) || "none in 20s"));
ok(owner.evs.some(e => e.type === "auth" && e.state === "starting"), "the owner saw it start before the URL arrived");

// 3b. clicking sign-in twice must not leave two `claude auth login` children racing for the same credentials
owner.send(JSON.stringify({ type: "login" }));
await new Promise(r => setTimeout(r, 2500));
if (process.env.JAM_AUTH_COUNT) { const { readFileSync } = await import("node:fs"); let n = 0; try { n = +readFileSync(process.env.JAM_AUTH_COUNT, "utf8") || 0; } catch {}
  ok(n === 1, "two sign-in clicks spawn exactly one login process (spawned " + n + ")"); }

// 4. a wrong code fails without claiming success
owner.send(JSON.stringify({ type: "login-code", code: "not-the-code" }));
const bad = await waitFor(owner.evs, e => e.type === "auth" && e.state === "failed", 20000);
ok(!!bad, "a wrong code reports failure, not success");
ok(!owner.evs.some(e => e.type === "auth" && e.state === "in"), "still not signed in after the wrong code");

// 5. the real code goes through and the room says who's signed in
owner.send(JSON.stringify({ type: "login" }));
ok(!!(await waitFor(owner.evs, e => e.type === "auth" && e.state === "url" && owner.evs.indexOf(e) > mark, 20000)), "a second sign-in can be started after a failure");
owner.send(JSON.stringify({ type: "login-code", code: GOOD }));
const inState = await waitFor(owner.evs, e => e.type === "auth" && e.state === "in", 25000);
ok(!!inState, "the code typed in the room completes the sign-in");
ok(inState && inState.email === "stub@example.com" && inState.plan === "max", "the signed-in card names the account: " + (inState ? inState.email + " / " + inState.plan : "n/a"));

// 6. it survives a reload: hello carries it for the owner, never for a driver
const owner2 = await sock(`room=${ROOM}&k=${K}&name=Mike`);
const hello = await waitFor(owner2.evs, e => e.type === "hello", 10000);
ok(hello && hello.auth && hello.auth.state === "in", "a reloading owner gets the auth state in hello: " + (hello?.auth?.state || "missing"));
const driver2 = await sock(`k=${tok}&name=Driver1`);
const dhello = await waitFor(driver2.evs, e => e.type === "hello", 10000);
ok(dhello && !dhello.auth, "a reloading driver gets no auth state in hello");
// the code itself must never be stored in the shared transcript
const hist = await (await fetch(`${httpBase(H)}/api/rooms/${ROOM}/history?k=${K}`)).json();
ok(!JSON.stringify(hist).includes(GOOD), "the code never lands in the stored transcript");

for (const w of [owner, driver, owner2, driver2]) { try { w.close(); } catch {} }
console.log(fail ? `\n${fail} auth FAILURES` : "\nauth: pass");
process.exit(fail ? 1 : 0);
