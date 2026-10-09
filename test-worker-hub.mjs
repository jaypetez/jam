#!/usr/bin/env node
// Offline test of the Worker's Hub REST surface and auth routing (2026-10-09). It imports the BUILT bundle (worker.js), so it also proves
// that build.sh's inlining of budget.mjs and worker-lib.mjs produced a working Worker. Cloudflare's Durable Object runtime is faked with a
// Map-backed storage and in-process stubs, which is fast and needs no wrangler; the websocket paths (/ws, /hub upgrade) and the Room DO are NOT
// covered here: test-stack.mjs and `npm run e2e` cover them on the real runtime (workerd).
import fs from "node:fs";
if (!fs.existsSync(new URL("./worker.js", import.meta.url))) { console.error("worker.js missing: run ./build.sh first"); process.exit(1); }
const mod = await import("./worker.js"); const worker = mod.default;
let fail = 0; const ok = (c, m, extra = "") => { if (!c) { fail++; console.log("FAIL " + m + " " + extra); } else console.log("PASS " + m); };

const store = new Map();
const state = { storage: { get: async k => store.get(k), put: async (k, v) => { store.set(k, structuredClone(v)); }, delete: async k => store.delete(k), list: async () => new Map(store) }, getWebSockets: () => [], acceptWebSocket() {} };
const roomCalls = [];
const asReq = (u, init) => typeof u === "string" ? new Request(u, init) : u;
const roomStub = { fetch: async (u, init) => { const r = asReq(u, init); const url = new URL(r.url); const body = r.method === "POST" ? await r.text() : ""; roomCalls.push({ path: url.pathname, method: r.method, body }); return url.pathname === "/dump" ? Response.json({ entries: [1, 2, 3] }) : Response.json({ ok: true }); } };
const hub = new mod.Hub(state, {});
const env = { JAM_KEY: "owner-key-123", HUB: { idFromName: n => n, get: () => ({ fetch: (u, init) => hub.fetch(asReq(u, init)) }) }, ROOM: { idFromName: n => n, get: () => roomStub } };
hub.env = env;

const call = async (path, { method = "GET", body, key = env.JAM_KEY, headers = {} } = {}) => {
  const sep = path.includes("?") ? "&" : "?";
  const res = await worker.fetch(new Request("https://jam.test" + path + (key ? sep + "k=" + encodeURIComponent(key) : ""), { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: "manual" }), env);
  let data = null; try { data = await res.clone().json(); } catch {}
  return { status: res.status, data, res };
};

// ── public surface
let r = await call("/health", { key: "" });
ok(r.status === 200 && r.data.ok && /^[0-9a-f]{10}$/.test(r.data.build), "/health reports the 10-hex build hash of the bundle", JSON.stringify(r.data));
r = await call("/", { key: "" }); ok(r.status === 200 && /text\/html/.test(r.res.headers.get("content-type")) && (await r.res.text()).toLowerCase().includes("<!doctype html"), "/ serves the embedded UI");
r = await call("/nonsense", { key: "" }); ok(r.status === 302 && r.res.headers.get("location") === "https://jam.test/", "unknown paths redirect to the lobby");
r = await call("/api/sponsor", { key: "" }); ok(r.status === 200 && r.data.sponsor === null, "GET /api/sponsor is public");
r = await call("/api/sponsor", { method: "POST", body: { name: "Acme" }, key: "" }); ok(r.status === 403, "…but setting a sponsor needs the owner key");

// ── auth
r = await call("/api/rooms", { key: "" }); ok(r.status === 403 && r.data.error === "owner only", "no key → 403 owner only");
r = await call("/api/rooms", { key: "wrong-key" }); ok(r.status === 403, "a wrong key → 403");
r = await call("/api/whoami"); ok(r.status === 200 && r.data.role === "owner", "the owner key resolves to owner");
r = await call("/ws?room=x", { key: "" }); ok(r.status === 403, "/ws without a key → 403");
r = await call("/hub", { key: "wrong" }); ok(r.status === 403, "/hub needs the owner key");

// ── rooms: create
r = await call("/api/rooms", { method: "POST", body: { name: "Jam", cwd: "/work/jam" } });
ok(r.status === 200 && r.data.room.name === "jam" && r.data.room.cwd === "/work/jam" && r.data.room.model === "auto" && r.data.room.tier === "auto" && r.data.room.effort === "auto", "create a room (name is normalised, defaults are auto)", JSON.stringify(r.data));
r = await call("/api/rooms", { method: "POST", body: { name: "JAM", cwd: "/x" } }); ok(r.status === 409 && /already exists/.test(r.data.error), "a duplicate name (any case) → 409");
r = await call("/api/rooms", { method: "POST", body: { name: "x" } }); ok(r.status === 400 && r.data.error === "cwd required", "missing cwd → 400");
r = await call("/api/rooms", { method: "POST", body: { name: "x", cwd: "Titan Index working session" } }); ok(r.status === 400 && /absolute path/.test(r.data.error), "a description in place of a path → 400 (2026-09-29)");
r = await call("/api/rooms", { method: "POST", body: { cwd: "/x" } }); ok(r.status === 400 && /room name/.test(r.data.error), "missing name → 400");
r = await call("/api/rooms", { method: "POST", body: { name: "hk", cwd: "/w", model: "claude-haiku-4-5", effort: "max", tier: "heavy" } }); ok(r.status === 200 && r.data.room.effort === "auto" && r.data.room.tier === "heavy", "a Haiku room never stores an effort level");
await call("/api/rooms", { method: "POST", body: { name: "other", cwd: "C:\\work\\other" } });
ok(store.get("rooms").jam && store.get("rooms").other, "rooms are persisted to storage");
r = await call("/api/rooms"); ok(r.data.rooms.map(x => x.name).join() === "jam,hk,other", "GET /api/rooms lists them in creation order", JSON.stringify(r.data.rooms.map(x => x.name)));

// ── settings
r = await call("/api/rooms/jam/settings", { method: "POST", body: { model: "claude-opus-5", tier: "heavy", effort: "high", runLocal: true } });
ok(r.status === 200 && r.data.room.model === "claude-opus-5" && r.data.room.tier === "heavy" && r.data.room.effort === "high" && r.data.room.runLocal === true, "settings: model / tier / effort / runLocal apply", JSON.stringify(r.data));
r = await call("/api/rooms/jam/settings", { method: "POST", body: { model: "claude-haiku-4-5" } }); ok(r.data.room.effort === "auto", "settings: pinning Haiku resets effort");
r = await call("/api/rooms/jam/settings", { method: "POST", body: { cwd: "relative/dir", tier: "light", runLocal: false } }); ok(r.status === 400 && /absolute path/.test(r.data.error), "settings: a relative cwd → 400");
r = await call("/api/rooms"); const jam = r.data.rooms.find(x => x.name === "jam"); ok(jam.tier === "heavy" && jam.runLocal === true && jam.cwd === "/work/jam", "…and the rejected request changed nothing", JSON.stringify(jam));
r = await call("/api/rooms/jam/settings", { method: "POST", body: { cwd: "/elsewhere" } }); ok(r.data.room.cwd === "/elsewhere", "settings: a new absolute cwd applies");
r = await call("/api/rooms/nope/settings", { method: "POST", body: {} }); ok(r.status === 404, "settings on a missing room → 404");
r = await call("/api/rooms/jam/settings", { method: "POST", body: { runLocal: "yes" } }); ok(r.data.room.runLocal === false, "runLocal only turns on for a real boolean true");

// ── order
r = await call("/api/rooms/order", { method: "POST", body: { order: ["other", "ghost", "jam"] } }); ok(r.status === 200 && r.data.order.join() === "other,jam,hk", "sidebar order: unknown dropped, unlisted rooms at the tail", JSON.stringify(r.data));
r = await call("/api/rooms"); ok(r.data.rooms.map(x => x.name).join() === "other,jam,hk", "…and GET /api/rooms follows it");
r = await call("/api/rooms/order", { method: "POST", body: { order: "jam" } }); ok(r.status === 400, "order must be an array");

// ── invites, driver access, owner-by-invite scoping
r = await call("/api/rooms/jam/invites", { method: "POST", body: { role: "driver", name: "Dee" } }); const driverTok = r.data.token;
ok(r.status === 200 && /^[a-z2-9]{12}$/.test(driverTok) && r.data.invite.role === "driver" && r.data.invite.room === "jam", "create a driver invite (12-char link-friendly token)", JSON.stringify(r.data));
r = await call("/api/rooms/jam/invites", { method: "POST", body: { role: "bogus" } }); ok(r.data.invite.role === "driver", "an unknown invite role falls back to driver, never owner");
r = await call("/api/rooms/jam/invites", { method: "POST", body: { role: "owner", name: "Co" } }); const ownTok = r.data.token;
r = await call("/api/whoami", { key: driverTok }); ok(r.status === 200 && r.data.role === "driver" && r.data.name === "Dee" && r.data.room.name === "jam", "a driver's token resolves to driver in its room", JSON.stringify(r.data));
r = await call("/api/rooms", { key: driverTok }); ok(r.status === 403, "a driver cannot use the owner API");
r = await call("/api/rooms", { key: ownTok }); ok(r.status === 200 && r.data.rooms.map(x => x.name).join() === "jam", "an owner-by-invite sees only its own room");
r = await call("/api/rooms/other/settings", { method: "POST", body: { tier: "light" }, key: ownTok }); ok(r.status === 403 && /scoped to jam/.test(r.data.error), "…cannot touch another room");
r = await call("/api/rooms", { method: "POST", body: { name: "evil", cwd: "/x" }, key: ownTok }); ok(r.status === 403, "…cannot create rooms");
r = await call("/api/rooms/jam/settings", { method: "POST", body: { tier: "medium" }, key: ownTok }); ok(r.status === 200, "…but can change its own room's settings");
r = await call("/api/rooms/jam/activity", { method: "POST", body: { seq: 1 } }); ok(r.status === 404, "internal /activity is blocked from the public router");
r = await call("/api/budget/check", { method: "POST", body: { t: driverTok } }); ok(r.status === 404, "internal /budget/* is blocked from the public router");

// ── budgets
r = await call(`/api/invites/${driverTok}/budget`, { method: "POST", body: { share: 40, downshift: true } }); ok(r.status === 200 && r.data.invite.budget.share === 40 && r.data.invite.budget.downshift === true, "set a driver's budget share");
r = await call(`/api/invites/${driverTok}/budget`, { method: "POST", body: { share: 140 } }); ok(r.status === 400, "a share above 100 is refused");
r = await call(`/api/invites/${driverTok}/budget`, { method: "POST", body: { share: "40" } }); ok(r.status === 400, "a non-numeric share is refused");
r = await call(`/api/invites/${ownTok}/budget`, { method: "POST", body: { share: 10 } }); ok(r.status === 400 && /driver invites only/.test(r.data.error), "budgets apply to driver invites only");
r = await call(`/api/invites/${driverTok}/budget`, { method: "POST", body: { share: 40 }, key: ownTok }); ok(r.status === 200, "an owner-by-invite may manage budgets in its own room");
r = await call(`/api/invites/${driverTok}/budget`, { method: "POST", body: { share: null } }); ok(r.status === 200 && !r.data.invite.budget, "a null share removes the limit");

// ── rename
r = await call("/api/rooms/other/rename", { method: "POST", body: { to: "Moved Room!" } }); ok(r.status === 200 && r.data.room.name === "movedroom" && r.data.entries === 3, "rename moves the transcript (dump → import) and reports its size", JSON.stringify(r.data));
ok(roomCalls.some(c => c.path === "/import") && roomCalls.some(c => c.path === "/wipe"), "…importing into the new room and wiping the old");
r = await call("/api/rooms"); ok(r.data.rooms.map(x => x.name).join() === "movedroom,jam,hk", "…and the sidebar order follows the new name", JSON.stringify(r.data.rooms.map(x => x.name)));
r = await call("/api/rooms/jam/rename", { method: "POST", body: { to: "hk" } }); ok(r.status === 400 && /already exists/.test(r.data.error), "renaming onto an existing room is refused");

// ── revoke + delete
r = await call(`/api/revoke/${ownTok}`, { method: "POST" }); ok(r.status === 200, "revoke an invite");
r = await call("/api/whoami", { key: ownTok }); ok(r.status === 403, "…its token stops working");
roomCalls.length = 0;
r = await call("/api/rooms/jam", { method: "DELETE" }); ok(r.status === 200, "delete a room");
ok(roomCalls.some(c => c.path === "/wipe" && /deleted/.test(c.body)), "…which wipes its transcript so a later room of the same name starts clean");
r = await call("/api/whoami", { key: driverTok }); ok(r.status === 403, "…and its invites die with it");
r = await call("/api/rooms"); ok(!r.data.rooms.some(x => x.name === "jam"), "…and it is gone from the list");
r = await call("/api/rooms/jam", { method: "DELETE" }); ok(r.status === 404, "deleting it again → 404");

console.log(fail ? `${fail} FAILED` : "all passed"); process.exit(fail ? 1 : 0);
