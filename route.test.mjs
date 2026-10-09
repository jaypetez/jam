#!/usr/bin/env node
// Unit tests for auto-routing. Offline; run by check.sh.
import { route, SMALL_WINDOW_SAFE } from "./route.mjs";

let fail = 0;
const is = (text, want, opts = {}) => {
  const r = route(text, opts);
  const ok = r.tier === want;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${want.padEnd(6)} ${ok ? "" : "→ got " + r.tier + " "}(${r.score}) ${JSON.stringify(text.slice(0, 52))} — ${r.why}`);
};

// chatty → light
is("hey", "light");
is("thanks!", "light");
is("lol", "light");
is("anything", "light");
is("what's the status?", "light");
is("are you done?", "light");

// small asks → medium
is("rename the room to jam", "medium");
is("explain what the bridge does", "medium");
is("check whether the bridge is running", "medium");
is("make the button blue", "medium");

// scheduler role: floor to medium, never a bump on top of a real score
is("what's the status?", "medium", { role: "scheduler" });
is("hey", "medium", { role: "scheduler" });
is("rename the room to jam", "medium", { role: "scheduler" });
is("build a battery gauge for context consumption in the sidebar", "heavy", { role: "scheduler" });

// pinned tier (per-schedule --tier): replaces scoring and the scheduler floor…
is("build a battery gauge for context consumption in the sidebar", "light", { forceTier: "light" });
is("hey", "heavy", { forceTier: "heavy" });
is("rename the room to jam", "light", { forceTier: "light", role: "scheduler" });   // pin beats the scheduler floor
is("deploy the worker and confirm the room still loads", "medium", { forceTier: "medium" });
// …but never the correctness guards: a crash retry still escalates, and a big context still needs the 1M window
is("hey", "medium", { forceTier: "light", bump: 1 });
is("hey", "heavy", { forceTier: "light", ctx: SMALL_WINDOW_SAFE + 1 });
is("hey", "heavy", { forceTier: "medium", ctx: SMALL_WINDOW_SAFE + 1 });
is("build a battery gauge for context consumption in the sidebar", "heavy", { forceTier: "bogus" }); // unknown pin is ignored

// real work → heavy
is("build a battery gauge for context consumption in the sidebar", "heavy");
is("why does this window keep scrolling to the top and then back down", "heavy");
is("refactor bridge.mjs so uploads stream instead of buffering", "heavy");
is("audit the approval hook for bypasses", "heavy");
is("deploy the worker and confirm the room still loads", "heavy");
is("add a test suite for the router", "heavy");

// signals that escalate
is("look at this", "heavy", { attachments: 1 });
is("thoughts?", "heavy", { mention: true });
is("fix the typo", "heavy", { ctx: 400000 });        // context guard beats complexity
is("hey", "heavy", { ctx: SMALL_WINDOW_SAFE + 1 });  // even chatter needs the big window
is("fix the typo", "heavy", { bump: 2 });            // retry escalation

// long multi-step prompt
is("first update the readme, and then re-run the tests\n- check the lobby\n- check mobile\n- confirm the gauge shows", "heavy");

// self-tuned thresholds override the defaults (tune-router.mjs persists these to ~/.jam/router-weights.json)
is("make the button blue", "heavy", { thresholds: { mediumAt: 0, heavyAt: 1 } });                                   // tightened: same ask, escalates further
is("build a battery gauge for context consumption in the sidebar", "medium", { thresholds: { mediumAt: 1, heavyAt: 10 } }); // loosened: same ask, stays cheaper

console.log(fail ? `\n${fail} routing FAILURES` : "\nrouting: all cases pass");
process.exit(fail ? 1 : 0);
