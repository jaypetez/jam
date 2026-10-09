#!/usr/bin/env node
// Unit tests for room-dispatch.mjs. Plain Node, no framework (see CLAUDE.md).
import { globMatch, isAbsCwd, bridgeOpensRoom, isDuplicateSay, rememberSay, isCompactCommand, isRouterMiss, sessionEvent } from "./room-dispatch.mjs";
let pass = 0, fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } };

eq("glob: exact", globMatch("jam", "jam"), true);
eq("glob: prefix star", [globMatch("test-qa-*", "test-qa-foo"), globMatch("test-*", "test-anything"), globMatch("test-qa-*", "test-other")], [true, true, false]);
eq("glob: anchored both ends", [globMatch("jam", "jam2"), globMatch("jam", "xjam")], [false, false]);
eq("glob: regex metacharacters are literal", [globMatch("a.b", "a.b"), globMatch("a.b", "axb"), globMatch("a+b", "a+b")], [true, false, true]);
eq("glob: an escaped star stays literal", globMatch("a\\*b", "aXb"), false);

eq("isAbsCwd accepts POSIX and Windows absolute paths", [isAbsCwd("/a/b"), isAbsCwd("C:\\a"), isAbsCwd("d:/a")], [true, true, true]);
eq("isAbsCwd rejects relative, empty and non-strings (#familypod, 2026-09-29)", [isAbsCwd("a/b"), isAbsCwd("./a"), isAbsCwd(""), isAbsCwd(null), isAbsCwd(5)], [false, false, false, false, false]);

eq("a normal bridge opens real rooms and not test-*", [bridgeOpensRoom("jam", []), bridgeOpensRoom("test-x", [])], [true, false]);
eq("an --only bridge opens only matching rooms (even non-test ones)", [bridgeOpensRoom("test-qa-1", ["test-qa-*"]), bridgeOpensRoom("jam", ["test-qa-*"]), bridgeOpensRoom("jam", ["jam", "other"])], [true, false, true]);

const room = () => ({ seen: new Set(["old"]), current: "run", queue: [{ id: "q" }] });
eq("duplicate say: seen, running, or queued", [isDuplicateSay(room(), { id: "old" }), isDuplicateSay(room(), { id: "run" }), isDuplicateSay(room(), { id: "q" })], [true, true, true]);
eq("a new say is not a duplicate", isDuplicateSay(room(), { id: "new" }), false);
{ const r = { seen: new Set() }; for (let i = 0; i < 600; i++) rememberSay(r, "m" + i);
  eq("seen is bounded at 500 and drops the OLDEST", [r.seen.size, r.seen.has("m0"), r.seen.has("m99"), r.seen.has("m100"), r.seen.has("m599")], [500, false, false, true, true]); }

eq("/compact detection", [isCompactCommand("/compact"), isCompactCommand("  /COMPACT now "), isCompactCommand("/compactify"), isCompactCommand("please /compact"), isCompactCommand(undefined)], [true, true, false, false, false]);

const now = 1e9, done = tier => ({ tier, ts: now - 60000 });
eq("a 'no,' after a light turn is a miss", isRouterMiss(done("light"), "no, that's wrong", now), true);
eq("…after a medium turn too", isRouterMiss(done("medium"), "try again", now), true);
eq("…but not after a heavy or manual turn (the router can't undershoot those)", [isRouterMiss(done("heavy"), "no, wrong", now), isRouterMiss(done("manual"), "no, wrong", now)], [false, false]);
eq("…not after ten minutes", isRouterMiss({ tier: "light", ts: now - 11 * 60000 }, "no, wrong", now), false);
eq("…not for ordinary text, or with no previous turn", [isRouterMiss(done("light"), "thanks!", now), isRouterMiss(null, "no, wrong", now)], [false, false]);

eq("sessionEvent shape (the UI's run-commands switch reads runLocal from it)", sessionEvent({ sessionId: "s", cfg: { cwd: "/c", model: "m", tier: "t", effort: "e", runLocal: 1 } }), { type: "session", id: "s", cwd: "/c", model: "m", tier: "t", effort: "e", runLocal: true });
eq("runLocal defaults to false, strictly boolean", sessionEvent({ sessionId: "s", cfg: { cwd: "/c" } }).runLocal, false);

console.log(`room-dispatch: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
