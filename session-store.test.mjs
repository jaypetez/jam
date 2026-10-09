#!/usr/bin/env node
// Unit tests for session-store.mjs against a throwaway state dir and fake ~/.claude. Plain Node, no framework (see CLAUDE.md).
import { createStore } from "./session-store.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
let pass = 0, fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } };

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "store-")));
const stateDir = path.join(root, ".jam"), home = path.join(root, "home"), cwdA = path.join(root, "projA"), cwdB = path.join(root, "projB");
for (const d of [cwdA, cwdB]) fs.mkdirSync(d, { recursive: true });
const logs = []; const S = createStore({ stateDir, home, log: (...a) => logs.push(a.join(" ")) });
const touchTranscript = (cwd, id) => { const f = S.transcriptOf(cwd, id); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "{}\n"); };

eq("sessions dir is created up front", fs.existsSync(path.join(stateDir, "sessions")), true);
eq("transcriptOf encodes every non-alphanumeric as '-'", path.basename(path.dirname(S.transcriptOf("/a/b.c_d", "x"))), path.resolve("/a/b.c_d").replace(/[^a-zA-Z0-9]/g, "-"));
eq("…under <home>/.claude/projects, named <id>.jsonl", S.transcriptOf("/a", "sid").startsWith(path.join(home, ".claude", "projects")) && S.transcriptOf("/a", "sid").endsWith("sid.jsonl"), true);

// sessionFor: brand-new room → new id, fresh; persisted
const cfgA = { name: "r1", cwd: cwdA };
const s1 = S.sessionFor(cfgA);
eq("new room is fresh with a uuid", [s1.fresh, /^[0-9a-f-]{36}$/.test(s1.id)], [true, true]);
eq("…and was written to disk", S.readSess(S.sessionFile("r1")).id, s1.id);
// same room, same cwd, but the transcript doesn't exist yet → still fresh (2026-09-14)
eq("known id with no transcript is still fresh", S.sessionFor(cfgA).fresh, true);
touchTranscript(cwdA, s1.id);
const s1b = S.sessionFor(cfgA);
eq("once a transcript exists the session resumes", [s1b.id, s1b.fresh], [s1.id, false]);
// ctx survives
S.saveSession({ cfg: cfgA, sessionId: s1.id, lastCtx: 12345 });
eq("saveSession keeps ctx", S.sessionFor(cfgA).ctx, 12345);
// cwd change → a new session, but the old one is remembered per cwd
const cfgB = { name: "r1", cwd: cwdB };
const s2 = S.sessionFor(cfgB);
eq("moving to a new directory starts a new session", s2.id !== s1.id && s2.fresh, true);
const onDisk = S.readSess(S.sessionFile("r1"));
eq("byCwd remembers both directories", onDisk.byCwd, { [cwdA]: s1.id, [cwdB]: s2.id });
const back = S.sessionFor(cfgA);
eq("moving back picks up the earlier conversation", [back.id, back.fresh], [s1.id, false]);
eq("…and says so in the log", logs.some(l => l.includes("resuming its earlier session")), true);
// legacy .jam-session in the cwd
const cwdC = path.join(root, "projC"); fs.mkdirSync(cwdC); fs.writeFileSync(path.join(cwdC, ".jam-session"), "legacy-id\n");
eq("a legacy .jam-session file is adopted", S.sessionFor({ name: "r2", cwd: cwdC }).id, "legacy-id");
// corrupt session file → treated as absent, new session
fs.writeFileSync(S.sessionFile("r3"), "{not json"); eq("a corrupt session file starts fresh instead of throwing", S.sessionFor({ name: "r3", cwd: cwdA }).fresh, true);

// queue persistence
const r = { cfg: { name: "q1" }, queue: [{ id: "a", text: "hi" }] };
S.saveQueue(r); eq("queue round-trips", S.loadQueue("q1"), [{ id: "a", text: "hi" }]);
eq("missing queue file → []", S.loadQueue("nope"), []);
fs.writeFileSync(S.queueFile("bad"), "xx"); eq("corrupt queue file → []", S.loadQueue("bad"), []);
eq("queue file name", path.basename(S.queueFile("q1")), "queue-q1.json");

// seed / notes locations
eq("seed and notes live beside the session", [path.basename(S.seedFile(r)), path.basename(S.notesFile(r))], ["q1.seed.md", "q1.notes.md"]);

// colors
eq("Claude is always green", S.assignColor("Claude"), "#86d68a");
const c1 = S.assignColor("Ann"), c2 = S.assignColor("Bob");
eq("users get distinct palette colors", c1 !== c2, true);
eq("a user keeps their color", S.assignColor("Ann"), c1);
const S2 = createStore({ stateDir, home }); eq("colors persist across a restart", S2.userColors.Ann, c1);
for (let i = 0; i < 10; i++) S.assignColor("U" + i);
eq("past the palette size, colors wrap instead of throwing", typeof S.assignColor("Overflow"), "string");

fs.rmSync(root, { recursive: true, force: true });
console.log(`session-store: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
