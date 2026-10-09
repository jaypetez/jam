#!/usr/bin/env node
// Unit tests for worker-lib.mjs (the pure Worker helpers inlined into worker.js). Plain Node, no framework (see CLAUDE.md).
import { cleanCatalog, cleanPlan, roomName, isAbsCwd, token, safeEq, normModel, normTier, normEffort, parseNewRoom, applyRoomSettings, orderRooms, ABS_CWD_MSG, TOKEN_ALPHABET } from "./worker-lib.mjs";
let pass = 0, fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); } };

// roomName / isAbsCwd
eq("roomName lowercases and strips everything but a-z 0-9 _ -", roomName("  My Room! #1_x-y "), "myroom1_x-y");
eq("roomName caps at 40 and tolerates junk", [roomName("a".repeat(60)).length, roomName(null), roomName(undefined), roomName(5)], [40, "", "", "5"]);
eq("isAbsCwd: POSIX and Windows absolute", [isAbsCwd("/a"), isAbsCwd("C:\\a"), isAbsCwd("c:/a")], [true, true, true]);
eq("isAbsCwd: descriptions and relative paths are refused (the #familypod bug, 2026-09-29)", [isAbsCwd("Titan Index working session"), isAbsCwd("a/b"), isAbsCwd("./a"), isAbsCwd("~/a"), isAbsCwd("")], [false, false, false, false, false]);

// token / safeEq
const toks = new Set(); for (let i = 0; i < 200; i++) toks.add(token());
eq("token: 12 chars from the link-friendly alphabet, no 0/o/1/l", [[...toks].every(t => t.length === 12 && [...t].every(c => TOKEN_ALPHABET.includes(c))), /[01ol]/.test([...toks].join("")), toks.size], [true, false, 200]);
eq("token length is a parameter", token(20).length, 20);
eq("safeEq: equal / different / different length", [safeEq("abc", "abc"), safeEq("abc", "abd"), safeEq("abc", "abcd")], [true, false, false]);
eq("safeEq refuses non-strings (an unset JAM_KEY must never match)", [safeEq(undefined, undefined), safeEq("a", undefined), safeEq(null, "a"), safeEq(1, 1)], [false, false, false, false]);
eq("safeEq: empty strings are equal (callers guard !k first)", safeEq("", ""), true);

// cleanCatalog: a bridge socket is owner-key only but still untrusted shape
eq("cleanCatalog rejects non-catalogs", [cleanCatalog(null), cleanCatalog({}), cleanCatalog({ models: "x" }), cleanCatalog({ models: [] }), cleanCatalog({ models: [{ nope: 1 }] })], [null, null, null, null, null]);
const cat = cleanCatalog({ models: [{ id: "claude-x", label: "X", family: "sonnet", window: 200000, maxOut: 64000, effort: ["high", "bogus", "low"], current: 1, price: { in: 3, out: 15, cacheRead: 0.3 }, evil: "<script>" }, { id: "y".repeat(81) }, { id: "m2", window: -5, price: { in: 1 } }, null], tiers: { light: "a", medium: 5, heavy: "c".repeat(81), extra: "z" }, ts: 123 });
eq("cleanCatalog keeps only well-formed fields", cat, { models: [
  { id: "claude-x", label: "X", family: "sonnet", window: 200000, maxOut: 64000, effort: ["low", "high"], current: true, price: { in: 3, out: 15, cacheRead: 0.3 } },
  { id: "m2", label: "m2", family: null, window: null, maxOut: null, effort: null, current: false, price: null }], tiers: { light: "a" }, ts: 123 });
eq("cleanCatalog caps the model list at 60", cleanCatalog({ models: Array.from({ length: 100 }, (_, i) => ({ id: "m" + i })) }).models.length, 60);

// cleanPlan
eq("cleanPlan rejects non-plans", [cleanPlan(null), cleanPlan({}), cleanPlan({ limits: [] }), cleanPlan({ limits: [{ kind: 5 }] })], [null, null, null, null]);
const plan = cleanPlan({ limits: [{ kind: "session", group: "g", percent: 250, resetsAt: 99, scope: "Opus", extra: 1 }, { kind: "weekly", percent: -3 }, { kind: "x".repeat(50), percent: "abc" }], rate: { session: 2, weekly: 99 }, ts: 7 });
eq("cleanPlan clamps percent to 0-100, drops absurd rates, trims strings", [plan.limits.map(l => l.percent), plan.limits[2].kind.length, plan.rate, plan.calibrated, plan.ts], [[100, 0, 0], 40, { session: 2, weekly: null }, true, 7]);
eq("cleanPlan caps limits at 12", cleanPlan({ limits: Array.from({ length: 30 }, () => ({ kind: "k" })) }).limits.length, 12);
eq("cleanPlan without usable rates is uncalibrated", cleanPlan({ limits: [{ kind: "k" }], rate: { session: 0, weekly: 100 } }).calibrated, false);

// normalisers
eq("normModel: default, trim to 60", [normModel(""), normModel(undefined), normModel("m".repeat(100)).length, normModel("claude-opus-5")], ["auto", "auto", 60, "claude-opus-5"]);
eq("normTier / normEffort: unknown → auto", [normTier("heavy"), normTier("auto"), normTier("huge"), normEffort("xhigh"), normEffort("ultra"), normEffort(undefined)], ["heavy", "auto", "auto", "xhigh", "auto", "auto"]);

// parseNewRoom: the error precedence is name → duplicate → cwd → absolute
const none = () => false;
eq("new room: name is required", parseNewRoom({ cwd: "/a" }, none), { error: "room name: a-z 0-9 - _" });
eq("…and junk-only names count as empty", parseNewRoom({ name: "!!!", cwd: "/a" }, none), { error: "room name: a-z 0-9 - _" });
eq("duplicate beats a missing cwd, with 409", parseNewRoom({ name: "Jam" }, n => n === "jam"), { error: "#jam already exists — room names are unique (case-insensitive)", status: 409 });
eq("cwd is required", parseNewRoom({ name: "jam" }, none), { error: "cwd required" });
eq("cwd must be absolute", parseNewRoom({ name: "jam", cwd: "my project" }, none), { error: ABS_CWD_MSG });
eq("a good room, defaults filled", parseNewRoom({ name: "Jam", cwd: "/p" }, none), { room: { name: "jam", cwd: "/p", model: "auto", tier: "auto", effort: "auto" } });
eq("tier/effort/model are normalised; Haiku never carries an effort", parseNewRoom({ name: "a", cwd: "/p", model: "claude-haiku-4-5", tier: "heavy", effort: "max" }, none).room, { name: "a", cwd: "/p", model: "claude-haiku-4-5", tier: "heavy", effort: "auto" });
eq("a non-Haiku model keeps its effort", parseNewRoom({ name: "a", cwd: "/p", model: "claude-opus-5", effort: "max" }, none).room.effort, "max");
eq("a null/garbage body is an error, not a crash", [parseNewRoom(null, none).error, parseNewRoom("x", none).error], ["room name: a-z 0-9 - _", "room name: a-z 0-9 - _"]);
eq("cwd is cut at 300 chars", parseNewRoom({ name: "a", cwd: "/" + "x".repeat(400) }, none).room.cwd.length, 300);

// applyRoomSettings
const room = () => ({ name: "r", cwd: "/old", model: "auto", tier: "auto", effort: "high" });
{ const r = room(); eq("settings: only the keys present are applied", [applyRoomSettings(r, { tier: "light" }), r], [null, { name: "r", cwd: "/old", model: "auto", tier: "light", effort: "high" }]); }
{ const r = room(); applyRoomSettings(r, { model: "claude-haiku-4-5" }); eq("pinning Haiku forces effort back to auto (stored state stays honest)", r.effort, "auto"); }
{ const r = room(); applyRoomSettings(r, { effort: "low" }); eq("…but plain effort changes stick on other models", r.effort, "low"); }
{ const r = room(); applyRoomSettings(r, { runLocal: "true" }); eq("runLocal is strictly boolean true", r.runLocal, false); applyRoomSettings(r, { runLocal: true }); eq("…true turns it on", r.runLocal, true); }
{ const r = room(); eq("a good cwd is applied", [applyRoomSettings(r, { cwd: "/new" }), r.cwd], [null, "/new"]); }
{ const r = room(), before = JSON.stringify(r); eq("a bad cwd is refused…", applyRoomSettings(r, { cwd: "relative", model: "claude-opus-5", tier: "heavy", runLocal: true }), ABS_CWD_MSG); eq("…and applies NOTHING (it used to leave model/tier/runLocal half-applied in memory)", JSON.stringify(r), before); }
{ const r = room(); eq("an empty cwd means 'unchanged'", [applyRoomSettings(r, { cwd: "" }), r.cwd], [null, "/old"]); }
{ const r = room(); eq("a null body is a no-op, not a crash", [applyRoomSettings(r, null), JSON.stringify(r)], [null, JSON.stringify(room())]); }

// orderRooms
const rooms = { a: {}, b: {}, c: {}, d: {} };
eq("requested names first, unlisted rooms keep their prior relative order at the tail", orderRooms(["c", "a"], ["d", "b"], rooms), ["c", "a", "d", "b"]);
eq("unknown and duplicate names are dropped; names are normalised", orderRooms(["C", "zzz", "c", "A!"], [], rooms), ["c", "a", "b", "d"]);
eq("no prior order: falls back to creation order", orderRooms([], null, rooms), ["a", "b", "c", "d"]);
eq("stale names in the prior order (deleted rooms) are dropped", orderRooms([], ["gone", "b"], rooms), ["b", "a", "c", "d"]);
eq("prototype keys can't be smuggled in as room names", orderRooms(["constructor", "__proto__", "toString"], [], rooms), ["a", "b", "c", "d"]);

console.log(`worker-lib: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
