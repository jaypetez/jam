#!/usr/bin/env node
// e2e: switching models by hand never strands a session.
//   1. a hand-picked model that's capped is swapped for the nearest model that fits, for that turn only;
//   2. switching to a model whose window the session has outgrown compacts first, then answers on that model —
//      and when no available model can reload the session, the handoff is written from the transcript.
// Run against a bridge started with test hooks (run-tests.sh does this):
//   JAM_ONLY=test-switch JAM_CAPPED=claude-haiku-4-5-20251001,claude-opus-5 JAM_WINDOWS='{"claude-sonnet-5":20000}' node bridge.mjs
//   K=<owner key> JAM_HOST=<host> ROOM=test-switch node switch.test.mjs
import { httpBase, wsBase, DEFAULT_HOST } from "./jam-url.mjs";
const K = process.env.K, H = process.env.JAM_HOST || DEFAULT_HOST, ROOM = process.env.ROOM || "test-switch";
const HAIKU = "claude-haiku-4-5-20251001", SONNET = "claude-sonnet-5", SONNET_WINDOW = 20000;
let fail = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };

const pin = async model => (await fetch(`${httpBase(H)}/api/rooms/${ROOM}/settings?k=${K}`, { method: "POST", body: JSON.stringify({ model }) })).json();
const ws = await new Promise((res, rej) => { const w = new WebSocket(`${wsBase(H)}/ws?room=${ROOM}&k=${K}&name=Mike`); w.onopen = () => res(w); w.onerror = () => rej(new Error("ws error")); });
const evs = []; ws.onmessage = ev => evs.push(JSON.parse(ev.data));
const say = t => ws.send(JSON.stringify({ type: "say", text: t }));
const waitFor = (pred, ms) => new Promise(res => { const t0 = Date.now(); const iv = setInterval(() => { const hit = evs.find(pred); if (hit || Date.now() - t0 > ms) { clearInterval(iv); res(hit || null); } }, 250); });
const since = mark => e => evs.indexOf(e) >= mark;

// ALL_CAPPED=1 (bridge started with every tier capped): a message gets a clear error at once, never a silent stall
if (process.env.ALL_CAPPED) {
  await pin("auto"); await new Promise(r => setTimeout(r, 2000));
  const mark = evs.length; say("hello there");
  const err = await waitFor(e => e.type === "error" && since(mark)(e), 15000);
  ok(err && /Every model is at its usage limit/.test(err.text), "every model capped → an error card within 15s: " + (err?.text || "stalled"));
  ok(!evs.some(e => e.type === "sys" && /Compact|Nothing to compact/.test(e.text) && since(mark)(e)), "no pointless compaction attempt");
  ws.close(); console.log(fail ? `\n${fail} all-capped FAILURES` : "\nall-capped: pass"); process.exit(fail ? 1 : 0);
}

// 1. pinned to Haiku, which is capped → runs on Sonnet, and says so
ok((await pin(HAIKU)).room?.model === HAIKU, "room pinned to Haiku 4.5 (capped by JAM_CAPPED)");
await new Promise(r => setTimeout(r, 2000));
let mark = evs.length; say("Remember this for later: the codeword is Marigold. Reply with one word: noted.");
const route1 = await waitFor(e => e.type === "route" && since(mark)(e), 60000);
ok(route1 && /Haiku 4\.5 capped → Sonnet 5/.test(route1.why) && /stays on Haiku 4\.5/.test(route1.why), "capped pin swapped for this turn, and the status says so: " + (route1?.why || "no route event"));
const d1 = await waitFor(e => e.type === "done" && since(mark)(e), 150000);
ok(d1 && /sonnet/i.test(d1.model || ""), "first turn answered on Sonnet 5 (" + (d1?.model || "timeout") + ")");
ok(!evs.some(e => e.type === "error" && since(mark)(e)), "no error card for the capped pin");
// precondition for part 2: the session must really be too big for the shrunken Sonnet window
ok(d1 && d1.ctx > SONNET_WINDOW * 0.75, `session (${d1?.ctx || "?"} tokens) outgrew the test's Sonnet window (${SONNET_WINDOW * 0.75} usable)`);

// 2. switch to Sonnet, which can't hold the session, with every other model capped → transcript compaction, then answer
ok((await pin(SONNET)).room?.model === SONNET, "room switched to Sonnet 5");
await new Promise(r => setTimeout(r, 2000));
mark = evs.length; say("What is the codeword? One word.");
const started = await waitFor(e => e.type === "sys" && /Compacting the session \(requested: Sonnet 5 can't hold/.test(e.text) && since(mark)(e), 30000);
ok(!!started, "compacts before loading the session into a window it outgrew: " + (started?.text || "no compaction"));
const done = await waitFor(e => e.type === "sys" && /^Compacted:/.test(e.text) && since(mark)(e), 240000);
ok(done && /from the transcript/.test(done.text), "no model could reload it, so the handoff came from the transcript: " + (done?.text || "timeout"));
const d2 = await waitFor(e => e.type === "done" && since(mark)(e), 240000);
ok(d2 && /sonnet/i.test(d2.model || ""), "answered on the newly picked Sonnet 5 (" + (d2?.model || "timeout") + ")");
ok(d2 && /marigold/i.test(d2.text || ""), "the fact survived the switch: " + (d2?.text || "").slice(0, 80).replace(/\n/g, " "));
ok(!evs.some(e => e.type === "error" && since(mark)(e)), "no error card for the switch");

await pin("auto"); ws.close();
console.log(fail ? `\n${fail} switch FAILURES` : "\nswitch: all cases pass"); process.exit(fail ? 1 : 0);
