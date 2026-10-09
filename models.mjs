// Model state and helpers, extracted from bridge.mjs (2026-10-09 review): which models are usage-capped, what context window each really
// has, how to step to the nearest model that fits. The bridge held these as ~10 module-level globals (catalog, capped, observedWin, …),
// so none of it could be tested. createModels() owns that state; `TIERS` is injected (route.mjs's singleton, which the bridge rewrites
// from the live catalog), and `now`/`log` are injectable so tests need neither a clock nor a console.

// Usage caps are remembered for an hour so routing and compaction step around a capped model instead of failing every turn
// (the Fable cap on 2026-09-11 turned every heavy turn into an instant error and made compaction impossible).
export const CAP_MS = 60 * 60 * 1000;

export function createModels({ TIERS, ORDER, SMALL_WINDOW_SAFE, windowOverride = {}, now = Date.now, log = () => {} }) {
  const capped = new Map(); // model -> capped until (ms); Infinity = capped for good (test hook)
  const observedWin = new Map(); // model id -> contextWindow from the last finished turn on it
  const M = { catalog: null, capped, observedWin };
  M.isCapped = m => (capped.get(m) || 0) > now();
  M.markCapped = (m, why) => { if (!m) return; capped.set(m, now() + CAP_MS); log("model capped for 60 min:", m, "—", String(why || "").replace(/\s+/g, " ").slice(0, 120)); };
  const entry = m => M.catalog?.models.find(x => x.id === m);
  M.entry = entry;
  // effort support comes from the live model catalog (Models API capabilities); before the first fetch, fall back to "not Haiku"
  M.supportsEffort = (m, level) => { const c = entry(m); return c && Array.isArray(c.effort) ? (level ? c.effort.includes(level) : c.effort.length > 0) : !/haiku/i.test(m || ""); };
  M.labelOf = m => entry(m)?.label || Object.values(TIERS).find(t => t.model === m)?.label || String(m).replace(/^claude-/, "").replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  M.tierOf = m => ORDER.find(t => TIERS[t].model === m) || null;
  // window: the smaller of what the catalog advertises and what Claude Code actually reported running that model at (a
  // 1M model can still run at 200k); neither known → its tier, else the smallest window — safe, never optimistic
  M.windowOf = m => { if (windowOverride[m]) return windowOverride[m]; const w = Math.min(observedWin.get(m) || Infinity, entry(m)?.window || Infinity); return w < Infinity ? w : TIERS[M.tierOf(m)]?.window || 200000; };
  // "fits" the way route.mjs decides it: SMALL_WINDOW_SAFE is the safe ceiling for a 200k window, scaled per window.
  // The 200k base is a constant on purpose — the catalog rewrites TIERS windows, and a bigger Haiku must not shrink every ratio.
  M.fits = (win, ctx) => ctx <= win * (SMALL_WINDOW_SAFE / 200000);
  // nearest uncapped tier whose window fits ctx: step down from `tier` first, then up; null when nothing fits
  M.fallbackTier = (tier, ctx) => {
    const i = ORDER.indexOf(tier); const order = [...ORDER.slice(0, i + 1).reverse(), ...ORDER.slice(i + 1)];
    return order.find(t => !M.isCapped(TIERS[t].model) && M.fits(M.windowOf(TIERS[t].model), ctx)) || null;
  };
  // Remember the window Claude Code reported for each model a finished turn used (modelUsage is keyed by model id, maybe with a "[1m]" suffix).
  M.observeWindows = modelUsage => { for (const [id, u] of Object.entries(modelUsage || {})) if (u?.contextWindow) observedWin.set(String(u.canonicalModel || id).replace(/\[.*\]$/, ""), u.contextWindow); };
  // Every model is capped: the cap is account-wide, so this can happen.
  M.allCapped = model => [model, ...ORDER.map(t => TIERS[t].model)].every(M.isCapped);
  return M;
}
