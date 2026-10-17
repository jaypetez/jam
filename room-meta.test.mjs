#!/usr/bin/env node
// Room meta round trip (2026-10-17): every field saveMeta() writes must come back from load() on a FRESH Room, as after a Durable Object
// eviction. Hand-written save/load lines drifted twice (`commands` saved but never read; an inline // comment swallowed six restores).
// Imports the BUILT worker.js (run ./build.sh first) with a Map-backed fake storage; no network.
import fs from "node:fs";
if (!fs.existsSync(new URL("./worker.js", import.meta.url))) { console.error("worker.js missing: run ./build.sh first"); process.exit(1); }
const mod = await import("./worker.js");
let fail = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };
const store = new Map();
const state = { id: { toString: () => "room" }, storage: { get: async k => structuredClone(store.get(k)), put: async (k, v) => { if (typeof k === "object") for (const [a, b] of Object.entries(k)) store.set(a, structuredClone(b)); else store.set(k, structuredClone(v)); }, delete: async k => store.delete(k), list: async () => new Map(store) }, getWebSockets: () => [], acceptWebSocket() {}, blockConcurrencyWhile: f => f() };
const src = fs.readFileSync(new URL("./worker.src.js", import.meta.url), "utf8");
const list = /const ROOM_MIRRORS = \(\) => \(\{([^}]*)\}\);/.exec(src);
ok(!!list, "worker.src.js has the ROOM_MIRRORS list");
const keys = list ? [...list[1].matchAll(/(\w+):/g)].map(m => m[1]) : [];
ok(keys.length >= 8, `ROOM_MIRRORS names every mirror (${keys.join(", ")})`);
const a = new mod.Room(state, {}); await a.load();
const want = {}; for (const k of keys) { want[k] = { sentinel: k, n: 7 }; a[k] = want[k]; }
await a.saveMeta();
const b = new mod.Room(state, {}); await b.load();
for (const k of keys) ok(JSON.stringify(b[k]) === JSON.stringify(want[k]), `${k} survives an eviction (save → fresh Room → load)`);
const saved = store.get("meta") || {};
for (const k of keys) ok(k in saved, `saveMeta writes ${k}`);
console.log(fail ? `room-meta: ${fail} FAIL` : "room-meta: all passed"); process.exit(fail ? 1 : 0);
