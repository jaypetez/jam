#!/usr/bin/env node
// Unit tests for turn-policy.mjs: the retry/outcome decisions, one row per incident or branch. Plain Node, no framework (see CLAUDE.md).
import { decideResult, decideNoResult, isCapHit, LIMIT_RE, TOO_LONG_RE, SESSION_LOCKED_RE, AUTH_RE, MISS_RE } from "./turn-policy.mjs";
let pass = 0, fail = 0;
const eq = (name, got, want) => { if (got === want) pass++; else { fail++; console.log(`FAIL ${name}: got ${got}, want ${want}`); } };

// ── regexes: real strings from the incidents named in turn-policy.mjs
eq("LIMIT_RE matches the Fable cap message", LIMIT_RE.test("You've reached your Fable limit · resets 3pm"), true);
eq("LIMIT_RE matches 'usage limit'", LIMIT_RE.test("Claude usage limit reached"), true);
eq("LIMIT_RE ignores ordinary errors", LIMIT_RE.test("ECONNRESET"), false);
eq("TOO_LONG_RE matches the CLI's wording", TOO_LONG_RE.test("Prompt is too long"), true);
eq("TOO_LONG_RE matches 'exceeds the maximum context'", TOO_LONG_RE.test("input exceeds the maximum context length"), true);
eq("SESSION_LOCKED_RE matches the 2026-10-08 lock message", SESSION_LOCKED_RE.test("Error: Session ID 1234-abcd is already in use."), true);
eq("AUTH_RE matches an expired OAuth token", AUTH_RE.test("OAuth token has expired"), true);
eq("AUTH_RE matches 401", AUTH_RE.test("API Error: 401"), true);
eq("AUTH_RE ignores 4010 widgets", AUTH_RE.test("processed 4010 files"), false);
eq("MISS_RE matches 'no, ...'", MISS_RE.test("no, that's wrong"), true);
eq("MISS_RE matches 'try again'", MISS_RE.test("try again please"), true);
eq("MISS_RE does not match 'nothing to add'", MISS_RE.test("nothing to add"), false);
eq("isCapHit needs is_error", isCapHit({ is_error: false, result: "usage limit" }), false);
eq("isCapHit tolerates a missing event", isCapHit(null), false);

// ── decideResult(ev, text, fresh, item)
const D = (ev, o = {}) => decideResult({ ev, text: o.text ?? "", fresh: o.fresh ?? false, item: o.item ?? {} });
const cap = { is_error: true, result: "You've reached your Opus limit" };
eq("cap → capRetry", D(cap), "capRetry");
eq("cap already retried → error card", D(cap, { item: { capRetried: true } }), "error");
eq("cap beats too-long when both match", D({ is_error: true, result: "usage limit; prompt is too long" }), "capRetry");
eq("too long on a resumed session → tooLongCompact", D({ is_error: true, result: "Prompt is too long" }), "tooLongCompact");
eq("too long already compacted once → error", D({ is_error: true, result: "Prompt is too long" }, { item: { longCompacted: true } }), "error");
eq("too long on a FRESH session is not a window problem → error", D({ is_error: true, result: "Prompt is too long" }, { fresh: true }), "error");
eq("No conversation found (resumed) → notResumable", D({ is_error: true, result: "No conversation found with session ID x" }), "notResumable");
eq("No conversation found but already retried → error", D({ is_error: true, result: "No conversation found" }, { item: { retried: true } }), "error");
eq("No conversation found on a fresh session → error", D({ is_error: true, result: "No conversation found" }, { fresh: true }), "error");
eq("plain error → error", D({ is_error: true, result: "boom" }), "error");
eq("error with empty result → error", D({ is_error: true, result: "" }), "error");
eq("instant empty non-error (2026-09-14) → emptyRetry", D({ is_error: false, result: "", duration_ms: 40 }), "emptyRetry");
eq("…but only once", D({ is_error: false, result: "", duration_ms: 40 }, { item: { retriedEmpty: true } }), "done");
eq("an empty result that took a while is a real (blank) answer → done", D({ is_error: false, result: "", duration_ms: 5000 }), "done");
eq("empty result but text streamed → done", D({ is_error: false, result: "", duration_ms: 10 }, { text: "hello" }), "done");
eq("normal answer → done", D({ is_error: false, result: "ok", duration_ms: 10 }), "done");
eq("missing duration counts as instant", D({ is_error: false, result: "" }), "emptyRetry");

// ── decideNoResult
const N = (o) => decideNoResult({ item: {}, fresh: false, stopped: false, code: 1, stderr: "", ...o });
eq("retryFresh flag wins over everything", N({ item: { retryFresh: true }, stderr: "Session ID x is already in use" }), "retryFresh");
eq("locked session (2026-10-08) → lockedAbandon, even when fresh", N({ stderr: "Session ID abc is already in use", fresh: true }), "lockedAbandon");
eq("locked twice → falls through to the crash retry", N({ stderr: "Session ID abc is already in use", item: { retriedLocked: true } }), "sessionNotFound");
eq("locked twice on a fresh session → crash retry", N({ stderr: "Session ID abc is already in use", item: { retriedLocked: true }, fresh: true }), "crashRetry");
eq("session gone on a resumed session → sessionNotFound", N({ stderr: "No conversation found" }), "sessionNotFound");
eq("session gone on a FRESH session is not retried as such", N({ stderr: "No conversation found", fresh: true }), "crashRetry");
eq("session retried already → crashRetry", N({ stderr: "session x", item: { retried: true } }), "crashRetry");
eq("scheduler crash → schedulerRetry", N({ item: { role: "scheduler" } }), "schedulerRetry");
eq("scheduler crash after a retry → schedulerFinal", N({ item: { role: "scheduler", schedulerRetries: 1 } }), "schedulerFinal");
eq("scheduler killed (code null) → error, never retried", N({ item: { role: "scheduler" }, code: null }), "error");
eq("scheduler stopped by the user → error", N({ item: { role: "scheduler" }, stopped: true }), "error");
eq("ordinary crash → crashRetry", N({}), "crashRetry");
eq("crash after a retry → error", N({ item: { retried2: true } }), "error");
eq("a watchdog kill (code null, marked) is retried once, as promised to the room", N({ code: null, item: { watchdogKilled: true } }), "crashRetry");
eq("…but only once", N({ code: null, item: { watchdogKilled: true, retried2: true } }), "error");
eq("…and never when the user also pressed Stop", N({ code: null, stopped: true, item: { watchdogKilled: true } }), "error");
eq("a watchdog-killed scheduler turn gets its one scheduler retry", N({ code: null, item: { role: "scheduler", watchdogKilled: true } }), "schedulerRetry");
eq("user Stop (code null) → error, not a crash retry", N({ code: null }), "error");
eq("crash within the stop grace window → error", N({ stopped: true }), "error");
eq("exit code 0 with no result still counts as a crash", N({ code: 0 }), "crashRetry");
eq("undefined stderr is tolerated", N({ stderr: undefined }), "crashRetry");

console.log(`turn-policy: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
