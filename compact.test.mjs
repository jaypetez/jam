#!/usr/bin/env node
// e2e: /compact writes a handoff, starts a fresh session, and the next turn still knows what was said before.
//   K=<owner key> JAM_HOST=<host> ROOM=test-compact node compact.test.mjs   (a bridge must be serving ROOM)
import { wsBase, DEFAULT_HOST } from "./jam-url.mjs";
import { readFileSync, existsSync } from "node:fs"; import os from "node:os"; import path from "node:path";
const K = process.env.K, H = process.env.JAM_HOST || DEFAULT_HOST, ROOM = process.env.ROOM || "test-compact";
let fail = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };
const sess = path.join(os.homedir(), ".jam", "sessions", ROOM + ".json"), seed = path.join(os.homedir(), ".jam", "sessions", ROOM + ".seed.md");
const readSess = () => { try { return JSON.parse(readFileSync(sess, "utf8")).id; } catch { return null; } };

const ws = await new Promise((res, rej) => { const w = new WebSocket(`${wsBase(H)}/ws?room=${ROOM}&k=${K}&name=Mike`); w.onopen = () => res(w); w.onerror = e => rej(new Error("ws error")); });
const evs = []; ws.onmessage = ev => evs.push(JSON.parse(ev.data));
const say = t => ws.send(JSON.stringify({ type: "say", text: t }));
const waitFor = (pred, ms, label) => new Promise(res => { const t0 = Date.now(); const iv = setInterval(() => { const hit = evs.find(pred); if (hit || Date.now() - t0 > ms) { clearInterval(iv); res(hit || null); } }, 250); });
const after = () => evs.length;

let mark = after(); say("Remember this for later: my favorite color is teal and the project codename is Bluebird. Reply with one word: noted.");
const d1 = await waitFor(e => e.type === "done" && evs.indexOf(e) >= mark, 120000); ok(!!d1, "first turn answered (" + (d1?.model || "?") + ")");
const id1 = readSess(); ok(!!id1, "session id recorded: " + (id1 || "").slice(0, 8));

mark = after(); say("/compact");
const started = await waitFor(e => e.type === "sys" && /Compacting the session/.test(e.text) && evs.indexOf(e) >= mark, 20000); ok(!!started, "compaction started on /compact");
const done = await waitFor(e => e.type === "sys" && /^Compacted:/.test(e.text) && evs.indexOf(e) >= mark, 240000); ok(!!done, "compaction finished: " + (done?.text || "timeout"));
const id2 = readSess(); ok(id2 && id2 !== id1, "fresh session id after compaction: " + (id2 || "").slice(0, 8));
ok(existsSync(seed), "handoff seed saved for the next turn");
const handoff = existsSync(seed) ? readFileSync(seed, "utf8") : "";
ok(/teal/i.test(handoff) && /bluebird/i.test(handoff), "handoff carries the facts (teal, Bluebird)");
ok(!/\b[0-9a-f]{48}\b/.test(handoff), "handoff contains no owner key");

mark = after(); say("What is my favorite color and what is the project codename? One line.");
const d2 = await waitFor(e => e.type === "done" && evs.indexOf(e) >= mark, 180000);
ok(!!d2, "turn after compaction answered (" + (d2?.model || "?") + ")");
ok(d2 && /teal/i.test(d2.text) && /bluebird/i.test(d2.text), "fresh session remembers via the handoff: " + (d2?.text || "").slice(0, 80).replace(/\n/g, " "));
ok(d2 && d2.ctx && d2.ctx < 60000, "context is small again after compaction (" + (d2?.ctx || "?") + " tokens)");
await new Promise(r => setTimeout(r, 500)); ok(!existsSync(seed), "seed consumed after the first turn");

ws.close(); console.log(fail ? `\n${fail} compact FAILURES` : "\ncompact: all cases pass"); process.exit(fail ? 1 : 0);
