// Turn-outcome policy, extracted from bridge.mjs runOne's finish() and onChildClose (2026-10-09 review). These two decisions were
// ten regex/flag guards threaded through side effects, and every 2026-09/10 incident in that code (stale session locks, instant empty
// replies, usage caps, forced-kill retries) lived in them. Here they are pure: facts in, an action name out. The bridge performs the
// action (requeue, send, compact), so the ORDER of the guards below is the contract. Do not reorder without a test case that says why.

// Usage caps ("You've reached your Fable limit…") come back as an is_error result, not a crash. Remember a capped
// model for an hour so routing and compaction step around it instead of failing every turn (the Fable cap on
// 2026-09-11 turned every heavy turn into an instant error and made compaction impossible).
export const LIMIT_RE = /reached your .{0,40}limit|usage limit/i;
// A session reloaded into a model whose window it has outgrown fails the same instant way a capped model does
export const TOO_LONG_RE = /prompt is too long|exceeds? the (maximum )?context|context (window|length) (exceeded|limit)/i;
// A forced kill (timeout, or ours after `kill -TERM`) can leave the CLI's own session lock held just long enough
// that an immediate --resume collides with it. This hit a genuinely fresh session (first turn after compaction,
// gotResult never true, so r.fresh never flips false) that the "No conversation found" fallback below explicitly
// excludes for fresh sessions — 2026-10-08: a forced-kill retry collided with its own stale lock twice, exhausted
// its one retry, and dropped the message with a raw error instead of recovering. A locked id can never un-lock
// itself by retrying the SAME id, fresh or not, so this check runs first and always starts a genuinely new one.
export const SESSION_LOCKED_RE = /session id .{0,80}already in use/i;
export const AUTH_RE = /oauth|invalid api key|authentication_error|authentication failed|please run [`"']?\/?login|token (?:has )?expired|expired token|not logged ?in|unauthorized|\b401\b/i;
// A "no, ..." or "that's not it" shortly after a light/medium turn means the router undershot (fed to tune-router.mjs).
export const MISS_RE = /^(no+[,!.]?\s|nope\b|wrong\b|that'?s not (it|right|what i (meant|asked))\b|not (quite|it)\b|try again\b|redo\b|incorrect\b)/i;

export const isCapHit = ev => !!(ev && ev.is_error && LIMIT_RE.test(String(ev.result || "")));

// A turn produced a `result` event. `fresh` is the room's r.fresh at that moment; `text` is what streamed. Returns one of:
//   capRetry         usage cap: retry once on whatever still fits
//   tooLongCompact   window estimate was wrong: compact, then run again
//   notResumable     "No conversation found": retry this turn as a fresh session (the caller must NOT log done / poll usage)
//   error            surface ev.result as an error card
//   emptyRetry       an instant, empty, non-error result is a turn that never ran (2026-09-14: seven in a row): retry once
//   done             a real answer
export function decideResult({ ev, text, fresh, item }) {
  const res = String(ev.result || "");
  if (isCapHit(ev) && !item.capRetried) return "capRetry";
  if (ev.is_error && !fresh && TOO_LONG_RE.test(res) && !item.longCompacted) return "tooLongCompact";
  if (ev.is_error && !fresh && !item.retried && /No conversation found/i.test(res)) return "notResumable";
  if (ev.is_error) return "error";
  if (!(ev.result || text) && (ev.duration_ms | 0) < 2000 && !item.retriedEmpty) return "emptyRetry";
  return "done";
}

// The process exited without ever producing a result. Returns one of:
//   retryFresh        a "not resumable" verdict from finish(): same id, --session-id this time
//   lockedAbandon     the session id is still locked: abandon it for a new one (once)
//   sessionNotFound   stderr says the session is gone: start a new one (once; never for a fresh session)
//   schedulerRetry    scheduler turn crashed (non-null exit, not stopped): retry once, no weight change
//   schedulerFinal    …and it already retried: report the failure
//   crashRetry        any other crash: retry once, one weight heavier
//   error             stopped by the user (code null), already retried, or stopped within the grace window
// `code === null` means we killed it: a user Stop or shutdown is never retried as a crash; a watchdog kill (item.watchdogKilled) is.
export function decideNoResult({ item, fresh, stopped, code, stderr }) {
  const err = String(stderr || "");
  if (item.retryFresh) return "retryFresh";
  if (SESSION_LOCKED_RE.test(err) && !item.retriedLocked) return "lockedAbandon";
  if (!fresh && /No conversation found|session/i.test(err) && !item.retried) return "sessionNotFound";
  // A watchdog kill (stuck turn, SIGTERM) also exits with code null, but unlike a user Stop it told the room "it'll retry once automatically"
  // (2026-10-09 review: it never did, because only a non-null exit code counted as a crash). The bridge marks the item before killing it.
  const crashed = code !== null || !!item.watchdogKilled;
  if (item.role === "scheduler" && crashed && !stopped) return (item.schedulerRetries ?? 0) < 1 ? "schedulerRetry" : "schedulerFinal";
  if (crashed && !item.retried2 && !stopped) return "crashRetry";
  return "error";
}
