// node budget.test.mjs — per-driver budget math (budget.mjs)
import { budgetStatus, driverView, learnRate, learnedRates, rollupSpend, SEED_RATE } from "./budget.mjs";
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.error("FAIL", msg); } };
const H = 3600e3, now = Date.parse("2026-09-15T16:00:00Z");
const plan = (sessionPct, weeklyPct, extra = {}) => ({ ts: now, calibrated: true, rate: { session: 2, weekly: 0.5 },
  limits: [{ kind: "session", group: "session", percent: sessionPct, resetsAt: now + 2 * H, scope: null },
           { kind: "weekly_all", group: "weekly", percent: weeklyPct, resetsAt: now + 72 * H, scope: null },
           { kind: "weekly_scoped", group: "weekly", percent: 99, resetsAt: now + 72 * H, scope: "Fable" }], ...extra });

// no budget → unlimited, still reports spend
let s = budgetStatus(null, [{ ts: now - H, cost: 3 }], plan(20, 40), now);
ok(s.state === "unlimited" && !s.limited && s.windows[0].usd === 3, "no budget is unlimited");
ok(driverView(s).limited === false && Object.keys(driverView(s)).length === 1, "driver view of unlimited hides everything");

// 50% share, host has 80% of the 5-hour left, driver spent $5 → 10 points; allowance = .5*(80+10)=45; left 35
s = budgetStatus({ share: 50 }, [{ ts: now - H, cost: 5 }], plan(20, 40), now);
const w5 = s.windows[0];
ok(w5.used === 10 && w5.allowance === 45 && w5.left === 35 && w5.state === "ok", "5-hour allowance flexes on host left + own use: " + JSON.stringify(w5));
ok(s.state === "ok", "ok state");
ok(s.windows[1].hostLeft === 60, "weekly uses the all-models limit, not the Fable-scoped one");

// host drains the plan elsewhere → same spend, smaller allowance
const s2 = budgetStatus({ share: 50 }, [{ ts: now - H, cost: 5 }], plan(80, 40), now);
ok(s2.windows[0].allowance < w5.allowance, "allowance shrinks as the host plan runs down");

// spend outside the window doesn't count
s = budgetStatus({ share: 50 }, [{ ts: now - 4 * H, cost: 100 }], plan(20, 40), now); // session window started now-3h
ok(s.windows[0].usd === 0 && s.windows[1].usd === 100, "only spend inside each window counts");

// low / downshift / blocked
s = budgetStatus({ share: 10, downshift: true }, [{ ts: now - H, cost: 0.9 }], plan(20, 0), now); // used 1.8, allowance .1*(81.8)=8.18
ok(s.windows[0].state === "ok", "under 80% is ok");
s = budgetStatus({ share: 10, downshift: true }, [{ ts: now - H, cost: 3.5 }], plan(20, 0), now); // used 7, allowance 8.7 → 80%+
ok(s.state === "downshift", "80%+ with downshift on → downshift, got " + s.state);
s = budgetStatus({ share: 10, downshift: false }, [{ ts: now - H, cost: 3.5 }], plan(20, 0), now);
ok(s.state === "low", "80%+ with downshift off → low");
s = budgetStatus({ share: 10 }, [{ ts: now - H, cost: 5 }], plan(20, 0), now); // used 10, allowance 9
ok(s.state === "blocked" && s.refillsAt === now + 2 * H && s.leftPct === 0, "over allowance → blocked, refills at the 5-hour reset");
ok(JSON.stringify(Object.keys(driverView(s)).sort()) === '["leftPct","limited","refillsAt","state"]', "driver view carries no plan or $ numbers");

// both windows blocked → refills at the later reset
s = budgetStatus({ share: 5 }, [{ ts: now - H, cost: 50 }], plan(20, 40), now);
ok(s.state === "blocked" && s.refillsAt === now + 72 * H, "both blocked → refills at the later reset");

// share 0 = paused
s = budgetStatus({ share: 0 }, [], plan(0, 0), now);
ok(s.state === "paused" && s.leftPct === 0 && s.refillsAt === null, "share 0 pauses the driver");

// host fully out → blocked even with 100% share and no own use
s = budgetStatus({ share: 100 }, [], plan(100, 10), now);
ok(s.state === "blocked", "host at 0% left blocks every limited driver");

// no plan reading yet → unknown, turns run
s = budgetStatus({ share: 25 }, [{ ts: now - H, cost: 1 }], null, now);
ok(s.state === "unknown" && s.windows[0].rate === SEED_RATE.session, "no plan reading → unknown with seed rate");

// a reading from before its window reset → fresh, full window; only spend after the reset counts
const old = plan(95, 40); old.limits[0].resetsAt = now - H;
s = budgetStatus({ share: 50 }, [{ ts: now - 2 * H, cost: 40 }, { ts: now - 0.5 * H, cost: 1 }], old, now);
ok(s.windows[0].hostLeft === 100 && s.windows[0].usd === 1, "rolled window counts as fresh: " + JSON.stringify(s.windows[0]));

// rate learning
let st = learnRate(null, plan(10, 50).limits, 100, now);
ok(learnedRates(st).session === null, "first reading only anchors");
st = learnRate(st, plan(11, 50).limits, 100.5, now + 60e3);
ok(learnedRates(st).session === null, "too little movement → no sample");
st = learnRate(st, plan(16, 52).limits, 104, now + 120e3); // +6% on $4 → 1.5; weekly +2% on $4 < $10 span → no sample
ok(learnedRates(st).session === 1.5 && learnedRates(st).weekly === null, "session sample 1.5, weekly waits for $10: " + JSON.stringify(learnedRates(st)));
st = learnRate(st, plan(24, 55).limits, 108, now + 180e3); // +8% on $4 → 2 → ewma 1.5*.7+2*.3 = 1.65
ok(learnedRates(st).session === 1.65, "EWMA blends samples: " + learnedRates(st).session);
const jitter = plan(25, 55); jitter.limits[0].resetsAt += 431; // same window, different sub-second fraction
st = learnRate(st, jitter.limits, 108.2, now + 200e3);
ok(st.session.anchor.percent === 24, "sub-second resets_at jitter doesn't re-anchor");
const reset = plan(3, 55); reset.limits[0].resetsAt = now + 7 * H;
st = learnRate(st, reset.limits, 109, now + 240e3);
ok(st.session.anchor.percent === 3 && learnedRates(st).session === 1.65, "window reset re-anchors, keeps the learned rate");

// a reading several windows old rolls to the current window, never reports a past refill
const ancient = plan(95, 40); ancient.limits[0].resetsAt = now - 11 * H; ancient.ts = now - 16 * H;
s = budgetStatus({ share: 10 }, [{ ts: now - 9.5 * H, cost: 6 }], ancient, now);
ok(s.windows[0].resetsAt > now && s.windows[0].usd === 0 && s.windows[0].hostLeft === 100, "multi-reset-old reading rolls forward: " + JSON.stringify(s.windows[0]));
ok(s.stale === true && (s.refillsAt === null || s.refillsAt > now), "old reading flagged stale, refill never in the past");

// a wild sample (plan moved 30% on $2 of jam spend) is capped at 3× the current belief
let wild = learnRate(null, plan(10, 50).limits, 0, now); wild = learnRate(wild, plan(40, 50).limits, 2, now + 60e3);
ok(learnedRates(wild).session <= 3 * SEED_RATE.session + 1e-9, "wild sample capped: " + learnedRates(wild).session);

// rollup keeps the total inside the weekly window
const many = Array.from({ length: 600 }, (_, i) => ({ ts: now - (600 - i) * 15 * 60e3 / 2, cost: 0.1, room: "jam", model: "m" }));
const rolledUp = rollupSpend(many, 400);
const inWeek = l => l.filter(x => x.ts >= now - 7 * 24 * H).reduce((a, x) => a + x.cost, 0);
ok(rolledUp.length <= 400 && Math.abs(inWeek(rolledUp) - inWeek(many)) < 1e-6, `rollup keeps weekly total (${inWeek(rolledUp).toFixed(2)} vs ${inWeek(many).toFixed(2)}, ${rolledUp.length} entries)`);

console.log(`budget: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
