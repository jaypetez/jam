#!/usr/bin/env node
// Unit tests for the router's nightly self-tuning math. Offline; run by check.sh.
import { computeAdjustment, MIN_SAMPLES } from "./tune-router.mjs";

let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };

{ const { weights, notes } = computeAdjustment({ light: { n: 5, misses: 4 } }, { mediumAt: 1, heavyAt: 3 });
  ok(weights.mediumAt === 1 && notes.length === 0, `below MIN_SAMPLES(${MIN_SAMPLES}) makes no change`); }

{ const { weights, notes } = computeAdjustment({ light: { n: 20, misses: 5 } }, { mediumAt: 1, heavyAt: 3 });
  ok(weights.mediumAt === 0, "high light miss rate (25%) lowers mediumAt: " + weights.mediumAt);
  ok(notes.length === 1, "one note logged: " + notes[0]); }

{ const { weights } = computeAdjustment({ medium: { n: 20, misses: 4 } }, { mediumAt: 1, heavyAt: 3 });
  ok(weights.heavyAt === 2, "high medium miss rate (20%) lowers heavyAt: " + weights.heavyAt); }

{ const { weights } = computeAdjustment({ light: { n: 30, misses: 0 } }, { mediumAt: 0, heavyAt: 3 });
  ok(weights.mediumAt === 1, "clean light tier (0% miss) eases mediumAt back up: " + weights.mediumAt); }

{ const { weights } = computeAdjustment({ light: { n: 30, misses: 10 } }, { mediumAt: 0, heavyAt: 3 });
  ok(weights.mediumAt === 0, "mediumAt floor holds at 0: " + weights.mediumAt); }

{ const { weights } = computeAdjustment({ medium: { n: 30, misses: 0 } }, { mediumAt: 1, heavyAt: 5 });
  ok(weights.heavyAt === 5, "heavyAt ceiling holds at 5: " + weights.heavyAt); }

{ const { weights, notes } = computeAdjustment({ light: { n: 20, misses: 2 }, medium: { n: 20, misses: 1 } }, { mediumAt: 1, heavyAt: 3 });
  ok(weights.mediumAt === 1 && weights.heavyAt === 3 && notes.length === 0, "mid-range miss rates (10%, 5%) leave both alone"); }

console.log(fail ? `\n${fail} tune-router FAILURES` : "\ntune-router: all cases pass");
process.exit(fail ? 1 : 0);
