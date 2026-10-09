// Pure pieces of the bridge's room handling, extracted from bridge.mjs (2026-10-09 review): which rooms a bridge opens, whether a `say`
// is a duplicate, whether a message is a /compact or a router "miss". The ws.onmessage handlers themselves, and every spawn(), stay in
// bridge.mjs, because check.sh's guards match their literal shape there. This module is what those handlers call into.
import { MISS_RE } from "./turn-policy.mjs";

// Simple glob matcher: "test-qa-*" matches "test-qa-foo", "test-*" matches "test-anything", exact match also works
export function globMatch(pattern, str) {
  const re = new RegExp("^" + pattern.split(/(?<!\\)\*/).map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(str);
}

export const isAbsCwd = s => typeof s === "string" && (/^\//.test(s) || /^[A-Za-z]:[\\/]/.test(s)); // POSIX or Windows absolute path

// test-* rooms are for --only bridges; --only patterns support * glob. A normal bridge never opens a test-* room.
export const bridgeOpensRoom = (name, only) => only.length ? only.some(p => globMatch(p, name)) : !String(name).startsWith("test-");

// The room DO replays its outbox on every bridge reconnect; anything already on disk (loadQueue) or mid-run must not run twice.
export const isDuplicateSay = (r, m) => r.seen.has(m.id) || r.current === m.id || r.queue.some(x => x.id === m.id);
export function rememberSay(r, id) { r.seen.add(id); if (r.seen.size > 500) r.seen.delete(r.seen.values().next().value); } // bounded: oldest id falls out first

export const isCompactCommand = text => /^\/compact\b/i.test(String(text || "").trim());

// A "no, ..." or "that's not it" shortly after a light/medium turn means the router undershot — it feeds the nightly self-tuner
// (tune-router.mjs) so the thresholds correct without a code change. One miss per turn: the caller clears r.lastDone.
export const isRouterMiss = (lastDone, text, now) => !!lastDone && (lastDone.tier === "light" || lastDone.tier === "medium") && MISS_RE.test(String(text || "").trim()) && now - lastDone.ts < 10 * 60 * 1000;

// The `session` event every room socket gets on connect, on a directory/model change and after each turn. It used to be written out five times.
export const sessionEvent = r => ({ type: "session", id: r.sessionId, cwd: r.cfg.cwd, model: r.cfg.model, tier: r.cfg.tier, effort: r.cfg.effort, runLocal: !!r.cfg.runLocal });
