// Per-driver budgets. A driver's allowance is a share of whatever is LEFT on the host's Claude plan, so it shrinks as
// the host (or anyone else) draws the plan down and refills when a window resets. Spend is metered in Claude Code's
// per-turn API-equivalent $ (exact and attributable) and converted to plan points (1 point = 1% of a window) with a
// rate the bridge learns by watching plan % move against jam spend; SEED_RATE until it has a sample.
// Pure functions: the Worker gets this file inlined at build time (build.sh strips `export`), the bridge imports it,
// budget.test.mjs covers it.

export const WINDOWS = { session: 5 * 3600e3, weekly: 7 * 86400e3 };
// plan % per API-$, measured 2026-09-15 (5-hour: 10% on $7.00 of jam turns; weekly: 57% on $131). Other sessions on
// the same account also move the plan, so jam-only samples read high: drivers get charged conservatively, never under.
export const SEED_RATE = { session: 1.4, weekly: 0.43 };
export const LOW_AT = 0.8;                       // "low" (and downshift, when on) once 80% of an allowance is used
export const STALE_MS = 30 * 60e3;               // a plan reading older than this is flagged stale to the owner (still used: host % only falls within a window)
const MIN_SPAN = { session: 2, weekly: 10 };     // $ of jam spend before a rate sample counts
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const r2 = v => Math.round(v * 100) / 100;

// the 5-hour limit, or the all-models weekly limit (a model-scoped weekly limit such as Fable's doesn't bound a driver)
export function planWindow(limits, kind) {
  return (Array.isArray(limits) ? limits : []).find(l => l && (kind === "session" ? l.kind === "session" : l.group === "weekly" && !l.scope)) || null;
}

export function budgetStatus(budget, spends, plan, now = Date.now()) {
  const share = budget && Number.isFinite(budget.share) ? clamp(Math.round(budget.share)) : null;
  const out = { limited: share !== null, share, downshift: !!(budget && budget.downshift), state: share === null ? "unlimited" : "unknown", windows: [], calibrated: !!(plan && plan.calibrated), planAt: plan && plan.ts || null, stale: !!(plan && plan.ts && now - plan.ts > STALE_MS), lowAt: LOW_AT };
  for (const kind of ["session", "weekly"]) {
    const lim = planWindow(plan && plan.limits, kind), span = WINDOWS[kind];
    const rate = plan && plan.rate && +plan.rate[kind] > 0 ? +plan.rate[kind] : SEED_RATE[kind];
    // a reading taken before its window reset says nothing about the windows since: roll forward to the current one
    // (however many resets ago), count it as fresh and full, and only count spend since the latest reset
    let resetsAt = lim && lim.resetsAt || null, rolled = false;
    while (resetsAt && resetsAt <= now) { resetsAt += span; rolled = true; }
    const start = !resetsAt ? now - span : resetsAt - span;
    const usd = (Array.isArray(spends) ? spends : []).reduce((s, x) => s + (x && x.ts >= start && x.ts <= now ? +x.cost || 0 : 0), 0);
    const used = usd * rate;
    const w = { kind, usd: r2(usd), used: r2(used), rate, resetsAt };
    if (lim) {
      w.hostLeft = rolled ? 100 : clamp(100 - (+lim.percent || 0));
      if (share !== null) {
        w.allowance = r2(share / 100 * Math.min(100, w.hostLeft + used)); // the driver's own use doesn't shrink their own allowance; everyone else's does
        w.left = r2(Math.max(0, w.allowance - used));
        w.leftPct = w.allowance > 0 ? Math.round(100 * w.left / w.allowance) : 0;
        w.allowanceUsd = r2(w.allowance / rate);
        w.state = w.allowance <= 0 || used >= w.allowance ? "blocked" : used >= LOW_AT * w.allowance ? "low" : "ok";
      }
    }
    out.windows.push(w);
  }
  if (share !== null) {
    const ws = out.windows.filter(w => w.state);
    if (share === 0) out.state = "paused";
    else if (!ws.length) out.state = "unknown"; // no plan reading yet: nothing to flex against, so turns run
    else if (ws.some(w => w.state === "blocked")) out.state = "blocked";
    else if (ws.some(w => w.state === "low")) out.state = out.downshift ? "downshift" : "low";
    else out.state = "ok";
    const blocked = ws.filter(w => w.state === "blocked"), bind = ws.length ? ws.reduce((a, b) => b.leftPct < a.leftPct ? b : a) : null;
    out.leftPct = share === 0 ? 0 : bind ? bind.leftPct : null;
    // refills when the LAST blocking window resets (both can be empty at once)
    out.refillsAt = share === 0 ? null : blocked.length ? Math.max(...blocked.map(w => w.resetsAt || 0)) || null : bind ? bind.resetsAt : null;
  }
  return out;
}

// what a driver may see about their own budget: no host plan numbers, no $
export function driverView(st) {
  if (!st || !st.limited) return { limited: false };
  return { limited: true, state: st.state, leftPct: st.leftPct, refillsAt: st.refillsAt };
}

// Learn plan points per $ from consecutive plan readings. Anchor at a reading; once both jam spend and plan % have moved
// enough within the same window, take a sample and re-anchor. A reset (new resetsAt, or % going down) re-anchors.
export function learnRate(state, limits, costTotal, now = Date.now()) {
  const st = state && typeof state === "object" ? state : {};
  for (const kind of ["session", "weekly"]) {
    const lim = planWindow(limits, kind); if (!lim) continue;
    const s = st[kind] && typeof st[kind] === "object" ? st[kind] : (st[kind] = { rate: null, n: 0, anchor: null });
    // resets_at comes back with the poll's own sub-second fraction (…20:30:00.971130 one call, .971399 the next): compare to the minute
    const a = s.anchor, pct = +lim.percent || 0, ra = lim.resetsAt ? Math.round(lim.resetsAt / 60e3) * 60e3 : null;
    const reanchor = () => { s.anchor = { resetsAt: ra, percent: pct, cost: costTotal, ts: now }; };
    if (!a || a.resetsAt !== ra || pct < a.percent || costTotal < a.cost) { reanchor(); continue; }
    const dp = pct - a.percent, dc = costTotal - a.cost;
    if (dc >= MIN_SPAN[kind] && dp >= 2) {
      // other sessions on the account move the plan with no jam $ behind them; cap a sample at 3× what we believe now,
      // so one busy hour elsewhere can't multiply every driver's charges
      const sample = clamp(dp / dc, 0.01, 3 * (s.rate || SEED_RATE[kind]));
      s.rate = Math.round((s.rate ? s.rate * 0.7 + sample * 0.3 : sample) * 1000) / 1000; s.n = (s.n | 0) + 1; reanchor();
    }
  }
  return st;
}
export const learnedRates = st => ({ session: st && st.session && st.session.rate || null, weekly: st && st.weekly && st.weekly.rate || null });

// Keep a token's spend list bounded without losing weekly totals: past `max` entries, fold the oldest into hourly
// buckets (stamped with their newest turn, so a bucket never drops out of a window early).
export function rollupSpend(list, max = 400) {
  if (!Array.isArray(list) || list.length <= max) return list || [];
  const keep = list.slice(-Math.floor(max / 2)), old = list.slice(0, list.length - keep.length), buckets = new Map();
  for (const x of old) { const k = Math.floor(x.ts / 3600e3); const b = buckets.get(k); if (b) { b.cost = Math.round((b.cost + (+x.cost || 0)) * 10000) / 10000; b.ts = Math.max(b.ts, x.ts); b.n = (b.n || 1) + (x.n || 1); } else buckets.set(k, { ...x, n: x.n || 1 }); }
  const rolled = [...buckets.values()].map(b => b.n > 1 ? { ...b, model: "", room: b.room } : b).sort((a, b) => a.ts - b.ts);
  return [...rolled, ...keep].slice(-max);
}
