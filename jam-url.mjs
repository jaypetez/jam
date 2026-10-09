// Which scheme a jam host speaks. Production is always TLS (https/wss); a local dev stack (`npm run dev`, `npm run e2e`) is plain http/ws on
// 127.0.0.1. Shared by the bridge, the approval hook, browser.mjs and the tests so no client hard-codes a scheme (2026-10-09: every Node client
// had `https://`/`wss://` baked in, which is why the end-to-end suite could only run against the production Worker). Import-free on purpose.
//
// Rule: JAM_SCHEME=http|https wins; otherwise a loopback host (127.x, localhost, ::1, with or without a port) is plain http, everything else is
// https. So an unset environment against a real hostname behaves exactly as before.
export const DEFAULT_HOST = "jam.nullagency.io";
const LOOPBACK = /^(?:127(?:\.\d{1,3}){3}|localhost|\[?::1\]?)(?::\d+)?$/i;
export const isLoopback = host => LOOPBACK.test(String(host || ""));
export function isSecure(host, env = process.env) {
  const s = String(env.JAM_SCHEME || "").toLowerCase();
  if (s === "http") return false;
  if (s === "https") return true;
  return !isLoopback(host);
}
export const httpBase = (host, env = process.env) => (isSecure(host, env) ? "https" : "http") + "://" + host;
export const wsBase = (host, env = process.env) => (isSecure(host, env) ? "wss" : "ws") + "://" + host;
