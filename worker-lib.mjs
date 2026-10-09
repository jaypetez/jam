// Pure helpers for the Worker, extracted from worker.src.js (2026-10-09 review) so they can be unit-tested under Node (worker-lib.test.mjs).
// Like budget.mjs this file is INLINED into worker.js by build.sh (listed in inline-modules.txt) with the leading `export ` stripped, so:
//   - no imports, and every top-level declaration starts with `export ` on its own line (no `export { a, b }` form: sed would leave `{ a, b }`);
//   - names are global to the Worker module, so they must not collide with anything in worker.src.js or budget.mjs.

export const ROLES = new Set(["owner", "driver", "viewer"]);
export const TIERS = new Set(["light", "medium", "heavy"]); // room-level ROUTING weight override for the auto-router (which model runs); "auto" (unset) lets it score each message itself. NOT Anthropic effort — see EFFORT_LEVELS.
export const EFFORT_LEVELS = new Set(["auto", "low", "medium", "high", "xhigh", "max"]); // Anthropic's real --effort levels (how hard the chosen model thinks); "auto" omits the flag
export const TOKEN_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/o/1/l, link-friendly
export const ABS_CWD_MSG = "cwd must be an absolute path (e.g. /Users/you/project or C:\\Users\\you\\project), not a description or a relative path";

// a catalog comes from a bridge socket (any owner key can open one): keep only well-formed fields, so a bad payload
// can't be stored and break every room page on load
export const LEVELS = ["low", "medium", "high", "xhigh", "max"];
export function cleanCatalog(m) {
  if (!m || !Array.isArray(m.models)) return null;
  const str = (v, n) => typeof v === "string" && v.length && v.length <= n ? v : null, num = v => Number.isFinite(v) && v >= 0 ? v : null;
  const models = m.models.slice(0, 60).filter(x => x && str(x.id, 80)).map(x => ({ id: x.id, label: str(x.label, 80) || x.id, family: str(x.family, 40), window: num(x.window), maxOut: num(x.maxOut),
    effort: Array.isArray(x.effort) ? LEVELS.filter(l => x.effort.includes(l)) : null, current: !!x.current,
    price: x.price && num(x.price.in) !== null && num(x.price.out) !== null ? { in: x.price.in, out: x.price.out, cacheRead: num(x.price.cacheRead) } : null }));
  const tiers = {}; for (const t of ["light", "medium", "heavy"]) if (m.tiers && str(m.tiers[t], 80)) tiers[t] = m.tiers[t];
  return models.length ? { models, tiers, ts: num(m.ts) || Date.now() } : null;
}
export function cleanPlan(m) {
  if (!m || !Array.isArray(m.limits)) return null;
  const limits = m.limits.slice(0, 12).filter(l => l && typeof l.kind === "string").map(l => ({ kind: l.kind.slice(0, 40), group: typeof l.group === "string" ? l.group.slice(0, 40) : null, percent: Math.max(0, Math.min(100, Number(l.percent) || 0)), resetsAt: Number.isFinite(l.resetsAt) ? l.resetsAt : null, scope: typeof l.scope === "string" ? l.scope.slice(0, 60) : null }));
  const num = v => Number.isFinite(v) && v > 0 && v < 50 ? v : null;
  return limits.length ? { limits, rate: { session: num(m.rate?.session), weekly: num(m.rate?.weekly) }, calibrated: !!(num(m.rate?.session) || num(m.rate?.weekly)), ts: Number.isFinite(m.ts) ? m.ts : Date.now() } : null;
}
export const roomName = s => String(s || "").replace(/[^a-z0-9_-]/gi, "").toLowerCase().slice(0, 40);
export const isAbsCwd = s => /^\//.test(s) || /^[A-Za-z]:[\\/]/.test(s); // POSIX (/…) or Windows (C:\… or C:/…) absolute path
export function token(n = 12) { const b = crypto.getRandomValues(new Uint8Array(n)); let s = ""; for (const x of b) s += TOKEN_ALPHABET[x % 32]; return s; }
export function safeEq(a, b) { if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

// Room fields an owner can set. "auto" means "let the router decide" / "omit the flag".
export const normModel = v => String(v || "auto").slice(0, 60) || "auto";
export const normTier = v => TIERS.has(v) ? v : "auto";
export const normEffort = v => EFFORT_LEVELS.has(v) ? v : "auto";

// POST /rooms body → { room } or { error, status? }. `exists(name)` tells whether the name is taken. The ORDER of the checks is the API's
// error precedence (name, then duplicate, then cwd), which the UI and run-tests.sh rely on.
export function parseNewRoom(b, exists) {
  if (!b || typeof b !== "object") b = {};
  const name = roomName(b.name); if (!name) return { error: "room name: a-z 0-9 - _" };
  if (exists(name)) return { error: "#" + name + " already exists — room names are unique (case-insensitive)", status: 409 };
  const cwd = String(b.cwd || "").slice(0, 300);
  if (!cwd) return { error: "cwd required" };
  // A relative cwd resolves against the BRIDGE PROCESS's own directory, not the intended project — e.g. a room
  // named/bio'd "Titan Index working session" with that same string typed into cwd silently created a stray
  // directory inside jam's own source tree instead of erroring (found 2026-09-29, two rooms live with this bug).
  if (!isAbsCwd(cwd)) return { error: ABS_CWD_MSG };
  const room = { name, cwd, model: normModel(b.model), tier: normTier(b.tier), effort: normEffort(b.effort) };
  if (/haiku/i.test(room.model)) room.effort = "auto"; // Haiku 4.5 doesn't take an effort parameter
  return { room };
}

// POST /rooms/<r>/settings: apply model / tier / effort / runLocal / cwd to the stored room `r`. Returns an error string, or null on success.
// The cwd is validated BEFORE anything is applied: it used to be checked last, so a bad cwd answered 400 but had already changed the in-memory
// model/tier/effort/runLocal (not saved or broadcast, but live until the next save).
export function applyRoomSettings(r, b) {
  if (!b || typeof b !== "object") b = {};
  let cwd = null; if (b.cwd) { cwd = String(b.cwd).slice(0, 300); if (!isAbsCwd(cwd)) return ABS_CWD_MSG; }
  if ("model" in b) r.model = normModel(b.model);
  if ("tier" in b) r.tier = normTier(b.tier);
  if ("effort" in b) r.effort = normEffort(b.effort);
  if ("runLocal" in b) r.runLocal = b.runLocal === true; // owner opt-in: drivers' shell commands in this room run without an Allow card (still inside the Seatbelt sandbox)
  if (/haiku/i.test(r.model)) r.effort = "auto"; // pinning Haiku 4.5 (or Auto landing there) can't carry an effort level — keep stored state honest about what actually runs
  if (cwd) r.cwd = cwd;
  return null;
}

// Sidebar order, hub-global: requested names first (unknown and duplicate names dropped), then whatever was already ordered, then any unlisted room.
export function orderRooms(requested, roomOrder, rooms) {
  const seen = new Set(), order = [];
  for (const n of requested.map(x => roomName(x))) if (n && Object.hasOwn(rooms, n) && !seen.has(n)) { seen.add(n); order.push(n); }
  for (const n of [...(roomOrder || []), ...Object.keys(rooms)]) if (Object.hasOwn(rooms, n) && !seen.has(n)) { seen.add(n); order.push(n); }
  return order;
}
