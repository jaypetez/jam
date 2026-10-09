#!/usr/bin/env node
// Unit tests for models.mjs: capped-model memory, window math, fallback tier. Plain Node, no framework (see CLAUDE.md).
import { createModels, CAP_MS } from "./models.mjs";
let pass = 0, fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } };

const mk = (extra = {}) => {
  const TIERS = { light: { model: "haiku", label: "Haiku", window: 200000 }, medium: { model: "sonnet", label: "Sonnet", window: 200000 }, heavy: { model: "opus", label: "Opus", window: 1000000 } };
  const clock = { t: 1000 }, logs = [];
  const M = createModels({ TIERS, ORDER: ["light", "medium", "heavy"], SMALL_WINDOW_SAFE: 150000, now: () => clock.t, log: (...a) => logs.push(a.join(" ")), ...extra });
  return { M, TIERS, clock, logs };
};

// caps expire after an hour, and the log line is the one ops greps for
{ const { M, clock, logs } = mk();
  eq("not capped initially", M.isCapped("opus"), false);
  M.markCapped("opus", "You've reached your   Opus limit\nresets 3pm");
  eq("capped right after marking", M.isCapped("opus"), true);
  eq("log line collapses whitespace", logs[0], "model capped for 60 min: opus — You've reached your Opus limit resets 3pm");
  clock.t += CAP_MS - 1; eq("still capped just before an hour", M.isCapped("opus"), true);
  clock.t += 2; eq("cap lapses after an hour", M.isCapped("opus"), false);
  M.markCapped(null, "x"); eq("markCapped(null) is a no-op", logs.length, 1);
  M.capped.set("haiku", Infinity); eq("Infinity cap (JAM_CAPPED test hook) never lapses", (clock.t += 1e12, M.isCapped("haiku")), true);
}

// window: min(observed, catalog); catalog-less falls back to the tier, then 200k; JAM_WINDOWS override wins
{ const { M, TIERS } = mk();
  eq("no catalog, known tier → tier window", M.windowOf("opus"), 1000000);
  eq("unknown model → safe 200k", M.windowOf("mystery"), 200000);
  M.observeWindows({ "opus[1m]": { contextWindow: 200000 } });
  eq("observed window shrinks a 1M model (strips the [1m] suffix)", M.windowOf("opus"), 200000);
  M.observeWindows({ x: { canonicalModel: "sonnet", contextWindow: 500000 }, y: {}, z: null });
  eq("canonicalModel is preferred as the key; empty/null usage ignored", M.windowOf("sonnet"), 500000);
  M.catalog = { models: [{ id: "sonnet", window: 300000, label: "Sonnet 5.1" }] };
  eq("min of observed and catalog", M.windowOf("sonnet"), 300000);
  void TIERS;
  const o = mk({ windowOverride: { opus: 20000 } }).M; eq("window override wins", o.windowOf("opus"), 20000);
}

// fits uses the 150k/200k ratio, not the tier's own window
{ const { M } = mk();
  eq("exactly the safe ceiling fits a 200k window", M.fits(200000, 150000), true);
  eq("one over doesn't", M.fits(200000, 150001), false);
  eq("a 1M window scales the ceiling", M.fits(1000000, 700000), true);
}

// fallbackTier: step down first, then up; skip capped and too-small; null when nothing fits
{ const { M } = mk();
  eq("nothing capped → the tier itself", M.fallbackTier("medium", 1000), "medium");
  M.markCapped("sonnet", "");
  eq("medium capped → steps DOWN to light first", M.fallbackTier("medium", 1000), "light");
  M.markCapped("haiku", "");
  eq("light also capped → then UP to heavy", M.fallbackTier("medium", 1000), "heavy");
  M.markCapped("opus", "");
  eq("everything capped → null", M.fallbackTier("medium", 1000), null);
  eq("allCapped sees it", M.allCapped("sonnet"), true);
}
{ const { M } = mk();
  M.markCapped("opus", "");
  eq("a 400k session on a capped 1M model: only >200k-window tiers fit, none left → null", M.fallbackTier("heavy", 400000), null);
  eq("allCapped is false while a tier is free", M.allCapped("opus"), false);
}

// labels, tiers, effort
{ const { M } = mk();
  eq("labelOf uses the tier label", M.labelOf("sonnet"), "Sonnet");
  eq("labelOf prettifies an unknown id", M.labelOf("claude-foo-bar-5"), "Foo Bar 5");
  eq("tierOf", [M.tierOf("haiku"), M.tierOf("nope")], ["light", null]);
  eq("supportsEffort before the catalog: everything but Haiku", [M.supportsEffort("claude-haiku-4-5"), M.supportsEffort("claude-sonnet-5", "high")], [false, true]);
  M.catalog = { models: [{ id: "sonnet", label: "From Catalog", effort: ["low", "high"] }, { id: "legacy" }] };
  eq("catalog label wins", M.labelOf("sonnet"), "From Catalog");
  eq("effort from the catalog", [M.supportsEffort("sonnet", "high"), M.supportsEffort("sonnet", "max"), M.supportsEffort("sonnet")], [true, false, true]);
  eq("catalog entry without an effort array falls back to the Haiku rule", M.supportsEffort("legacy", "high"), true);
}

console.log(`models: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
