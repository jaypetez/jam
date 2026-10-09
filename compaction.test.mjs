#!/usr/bin/env node
// Unit tests for compaction.mjs. Plain Node, no framework (see CLAUDE.md). Env overrides are NOT set here: defaults are what production runs.
import { compactAt, hardCompactDue, idleCompactDue, compactAttempts, handoffInput, transcriptTail, kfmt, HANDOFF_PROMPT, PORTABLE_AT, COMPACT_MIN_TURNS, COMPACT_IDLE_AT, COMPACT_IDLE_MS, WINDOW_HEADROOM } from "./compaction.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
let pass = 0, fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } };

eq("kfmt", [kfmt(999), kfmt(1000), kfmt(149600), kfmt(0)], ["999", "1k", "150k", "0"]);
eq("default portable ceiling is the 200k-window safe size", PORTABLE_AT, 150000);

// thresholds: min(portable, 80% of the window that ran the turn); a 200k window compacts at 150k (80% = 160k), 1M at 150k (portable)
eq("200k window → 150k (portable beats 80%)", compactAt(200000, { override: null }), 150000);
eq("100k window → 80k (headroom beats portable)", compactAt(100000, { override: null }), Math.round(100000 * WINDOW_HEADROOM));
eq("1M window → still 150k so ANY model can pick the session up", compactAt(1000000, { override: null }), 150000);
eq("an override wins (tests)", compactAt(1000000, { override: 5000 }), 5000);
const base = { ctx: 150000, windowMax: 200000, turnsSinceCompact: COMPACT_MIN_TURNS, compactWanted: null };
eq("due at the threshold", hardCompactDue(base, { override: null }), true);
eq("not due just below", hardCompactDue({ ...base, ctx: 149999 }, { override: null }), false);
eq("never twice within COMPACT_MIN_TURNS turns", hardCompactDue({ ...base, turnsSinceCompact: COMPACT_MIN_TURNS - 1 }, { override: null }), false);
eq("not due while one is already wanted", hardCompactDue({ ...base, compactWanted: "requested by x" }, { override: null }), false);

// idle compaction
const idle = { child: null, running: false, queue: [], compacting: false, fresh: false, lastCtx: COMPACT_IDLE_AT, turnsSinceCompact: COMPACT_MIN_TURNS, lastActivity: 0 };
eq("idle room with enough context is due", idleCompactDue(idle, COMPACT_IDLE_MS + 1), true);
eq("…not before the idle window passes", idleCompactDue(idle, COMPACT_IDLE_MS), false);
for (const [k, v] of Object.entries({ child: {}, running: true, queue: [1], compacting: true, fresh: true, lastCtx: COMPACT_IDLE_AT - 1, turnsSinceCompact: COMPACT_MIN_TURNS - 1 }))
  eq(`idle compaction is blocked by ${k}`, idleCompactDue({ ...idle, [k]: v }, COMPACT_IDLE_MS + 1), false);
eq("a missing turnsSinceCompact counts as 0", idleCompactDue({ ...idle, turnsSinceCompact: undefined }, COMPACT_IDLE_MS + 1), false);

// attempt order: resume attempts (pinned, heavy, medium, light; only where the session fits) then transcript attempts (medium, pinned, heavy, light)
const tiers = { light: { model: "haiku" }, medium: { model: "sonnet" }, heavy: { model: "opus" } };
const win = { haiku: 200000, sonnet: 200000, opus: 1000000, pinned: 200000 };
const fits = (w, c) => c <= w * 0.75, windowOf = m => win[m];
eq("small session: every distinct model resumes, pinned first", compactAttempts({ pinned: "pinned", tiers, fits, windowOf, lastCtx: 1000 }),
  [{ m: "pinned", resume: true }, { m: "opus", resume: true }, { m: "sonnet", resume: true }, { m: "haiku", resume: true },
   { m: "sonnet", resume: false }, { m: "pinned", resume: false }, { m: "opus", resume: false }, { m: "haiku", resume: false }]);
eq("big session: only the 1M model can reload it; the transcript path stays as the way out", compactAttempts({ pinned: null, tiers, fits, windowOf, lastCtx: 400000 }),
  [{ m: "opus", resume: true }, { m: "sonnet", resume: false }, { m: "opus", resume: false }, { m: "haiku", resume: false }]);
eq("a pinned model equal to a tier isn't tried twice", compactAttempts({ pinned: "sonnet", tiers, fits, windowOf, lastCtx: 1 }).filter(a => a.resume).map(a => a.m), ["sonnet", "opus", "haiku"]);
eq("a session too big for everyone has only transcript attempts", compactAttempts({ pinned: null, tiers, fits, windowOf, lastCtx: 5e6 }).every(a => !a.resume), true);

// prompts
eq("resume mode asks with the bare handoff prompt", handoffInput({ resume: true, roomName: "jam", tail: "T" }), HANDOFF_PROMPT);
const tin = handoffInput({ resume: false, roomName: "jam", tail: "SECRET-TAIL" });
eq("transcript mode frames the tail as material (instructions before AND after)", [tin.includes("<transcript>\nSECRET-TAIL\n</transcript>"), tin.indexOf("Do not answer") < tin.indexOf("<transcript>\nSECRET"), tin.indexOf("Now write the handoff") > tin.indexOf("</transcript>")], [true, true, true]);
eq("…and drops the 'you are about to be compacted' lead-in", [tin.includes("You are about to be compacted"), tin.includes("Plain markdown, no tool calls")], [false, true]);
eq("…and names the room", tin.includes("#jam"), true);

// transcriptTail against a fake ~/.claude/projects tree
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ctail-"));
const proj = path.join(home, ".claude", "projects", "-some-proj"); fs.mkdirSync(proj, { recursive: true });
const L = o => JSON.stringify(o);
fs.writeFileSync(path.join(proj, "sess1.jsonl"), [
  L({ type: "user", message: { content: "[Room notes — durable memory for #jam, kept at /x.\n\n---\n\n[Ann]: hello there" } }),
  L({ type: "summary" }),
  "not json",
  L({ type: "assistant", message: { content: [{ type: "text", text: "Hi Ann" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] } }),
  L({ type: "user", message: { content: [{ type: "tool_result", content: "file1\nfile2" }] } }),
  L({ type: "assistant", message: { content: [] } }),
].join("\n"));
const tail = transcriptTail(home, "sess1");
eq("tail is oldest-first, role-labelled", tail.split("\n\n").map(s => s.split(":")[0]), ["USER", "ASSISTANT", "TOOL"]);
eq("the room-notes block is stripped from user turns", tail.startsWith("USER: [Ann]: hello there"), true);
eq("tool calls and results are summarised", [tail.includes('[Bash: {"command":"ls"}]'), tail.includes("[result: file1\nfile2]")], [true, true]);
eq("junk lines and empty turns are skipped", tail.includes("not json") || tail.includes("summary"), false);
eq("unknown session → empty string", transcriptTail(home, "nope"), "");
eq("missing ~/.claude → empty string", transcriptTail(path.join(home, "nowhere"), "sess1"), "");
const capped = transcriptTail(home, "sess1", 30); eq("maxChars keeps the NEWEST text", capped.length <= 30 && capped.endsWith("file2]"), true);
fs.rmSync(home, { recursive: true, force: true });

console.log(`compaction: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
