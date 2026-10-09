// jam router self-tuning — nightly re-fit of the light/medium/heavy score cutoffs from logged misses.
// A "miss" is a reply like "no, ..." or "that's not it" arriving shortly after a light/medium turn: the model
// undershot. Pure core (computeAdjustment) is unit-tested offline (tune-router.test.mjs, run by check.sh);
// runTuning does the file IO and is called by bridge.mjs on a timer.
import { readFileSync, existsSync, appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_THRESHOLDS } from "./route.mjs";

export const MIN_SAMPLES = 15;   // don't touch a tier until it's seen enough turns to trust the rate
export const TIGHTEN_AT = 0.15;  // miss rate above this: too many asks are undershooting this tier — escalate more
export const LOOSEN_AT = 0.03;   // miss rate below this (with a full sample): ease back toward the defaults
export const BOUNDS = { mediumAt: [0, 2], heavyAt: [2, 5] };

/**
 * @param {object} stats     { light?: {n, misses}, medium?: {n, misses} } — turn counts and miss counts per tier
 * @param {object} weights   current { mediumAt, heavyAt }
 * @returns {{weights: object, notes: string[]}} the (possibly adjusted) weights, and a human note per change
 */
export function computeAdjustment(stats, weights) {
  const w = { ...weights };
  const notes = [];
  const clamp = (v, [lo, hi]) => Math.max(lo, Math.min(hi, v));
  // light misses too much → lower mediumAt so more of it escalates out of light.
  // medium misses too much → lower heavyAt so more of it escalates out of medium.
  for (const [tier, key, dir] of [["light", "mediumAt", -1], ["medium", "heavyAt", -1]]) {
    const s = stats[tier];
    if (!s || s.n < MIN_SAMPLES) continue;
    const rate = s.misses / s.n;
    let next = w[key];
    if (rate > TIGHTEN_AT) next = clamp(w[key] + dir, BOUNDS[key]);
    else if (rate < LOOSEN_AT) next = clamp(w[key] - dir, BOUNDS[key]);
    if (next !== w[key]) { notes.push(`${tier} miss rate ${Math.round(rate * 100)}% (${s.misses}/${s.n}) — ${key} ${w[key]}→${next}`); w[key] = next; }
  }
  return { weights: w, notes };
}

const readJsonl = f => {
  try { return readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
};

export function loadWeights(stateDir) {
  const f = path.join(stateDir, "router-weights.json");
  try { return { ...DEFAULT_THRESHOLDS, ...JSON.parse(readFileSync(f, "utf8")) }; } catch { return { ...DEFAULT_THRESHOLDS }; }
}

// Reads routing.jsonl + misses.jsonl, computes per-tier miss rates, and — if the data justifies a change —
// writes the new weights to ~/.jam/router-weights.json and appends the decision to tuning.jsonl. Returns the
// (possibly unchanged) weights either way.
export function runTuning(stateDir) {
  const routingFile = path.join(stateDir, "routing.jsonl"), missesFile = path.join(stateDir, "misses.jsonl"), weightsFile = path.join(stateDir, "router-weights.json");
  const routed = readJsonl(routingFile).filter(r => typeof r.score === "number");
  const missed = new Set(readJsonl(missesFile).map(m => m.id));
  const stats = {};
  for (const r of routed) {
    if (r.tier !== "light" && r.tier !== "medium") continue;
    (stats[r.tier] ||= { n: 0, misses: 0 }).n++;
    if (r.id && missed.has(r.id)) stats[r.tier].misses++;
  }
  const weights = loadWeights(stateDir);
  const { weights: next, notes } = computeAdjustment(stats, weights);
  if (notes.length) {
    writeFileSync(weightsFile, JSON.stringify({ ...next, updatedAt: new Date().toISOString(), reason: notes.join("; ") }, null, 1));
    try { appendFileSync(path.join(stateDir, "tuning.jsonl"), JSON.stringify({ ts: Date.now(), stats, from: weights, to: next, notes }) + "\n"); } catch {}
  }
  return { weights: next, stats, notes };
}
