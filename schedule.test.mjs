import { Schedule, ScheduleManager } from "./schedule.mjs";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Test cases
const tests = [
  {
    name: "every minute",
    when: "* * * * *",
    time: new Date("2026-09-05T08:30:45Z"),
    expect: true,
  },
  {
    name: "every 15 minutes",
    when: "*/15 * * * *",
    time: new Date("2026-09-05T08:30:00Z"),
    expect: true,
  },
  {
    name: "every 15 minutes (not at :45)",
    when: "*/15 * * * *",
    time: new Date("2026-09-05T08:45:00Z"),
    expect: true,
  },
  {
    name: "every 15 minutes (not at :07)",
    when: "*/15 * * * *",
    time: new Date("2026-09-05T08:37:00Z"),
    expect: false,
  },
  {
    name: "at 8am daily",
    when: "0 8 * * *",
    time: new Date("2026-09-05T08:00:00Z"),
    expect: true,
  },
  {
    name: "at 8am daily (wrong hour)",
    when: "0 8 * * *",
    time: new Date("2026-09-05T09:00:00Z"),
    expect: false,
  },
  {
    name: "at 8:30am daily",
    when: "30 8 * * *",
    time: new Date("2026-09-05T08:30:00Z"),
    expect: true,
  },
  {
    name: "every hour on the hour",
    when: "0 * * * *",
    time: new Date("2026-09-05T08:00:00Z"),
    expect: true,
  },
  {
    name: "every 6 hours",
    when: "0 */6 * * *",
    time: new Date("2026-09-05T18:00:00Z"),
    expect: true,
  },
  {
    name: "weekday only (Friday)",
    when: "0 8 * * 5",
    time: new Date("2026-09-04T08:00:00Z"), // Friday
    expect: true,
  },
  {
    name: "weekday only (Saturday, should fail)",
    when: "0 8 * * 5",
    time: new Date("2026-09-05T08:00:00Z"), // Saturday
    expect: false,
  },
  {
    name: "specific date of month",
    when: "0 8 5 * *",
    time: new Date("2026-09-05T08:00:00Z"),
    expect: true,
  },
  {
    name: "specific date (wrong date)",
    when: "0 8 5 * *",
    time: new Date("2026-09-04T08:00:00Z"),
    expect: false,
  },
];

let passed = 0;
let failed = 0;

for (const test of tests) {
  const s = new Schedule("test", "prompt", test.when);
  const result = s.matches(test.time);
  if (result === test.expect) {
    console.log(`✓ ${test.name}`);
    passed++;
  } else {
    console.log(`✗ ${test.name} — expected ${test.expect}, got ${result}`);
    failed++;
  }
}

// ── catch-up semantics: shouldRun fires the most recent due slot once, even if the exact minute was slept through ──
const T = iso => new Date(iso).getTime();
const catchup = [
  { name: "exact minute fires", run: () => { const s = new Schedule("t", "p", "0 9 * * *", null, null, T("2026-09-08T00:00:00Z")); return s.shouldRun(new Date("2026-09-09T09:00:07Z")) && s.dueAt === T("2026-09-09T09:00:00Z"); } },
  { name: "slept through 09:00, tick at 09:04 still fires (dueAt = 09:00)", run: () => { const s = new Schedule("t", "p", "0 9 * * *", null, null, T("2026-09-08T00:00:00Z")); return s.shouldRun(new Date("2026-09-09T09:04:33Z")) && s.dueAt === T("2026-09-09T09:00:00Z"); } },
  { name: "woke 6h late still fires once", run: () => { const s = new Schedule("t", "p", "0 9 * * *", null, null, T("2026-09-08T00:00:00Z")); return s.shouldRun(new Date("2026-09-09T15:00:00Z")); } },
  { name: "same slot does not refire after markRun", run: () => { const s = new Schedule("t", "p", "0 9 * * *", null, null, T("2026-09-08T00:00:00Z")); s.shouldRun(new Date("2026-09-09T09:04:00Z")); s.lastRun = T("2026-09-09T09:04:00Z"); return s.shouldRun(new Date("2026-09-09T09:05:00Z")) === false && s.shouldRun(new Date("2026-09-09T23:59:00Z")) === false; } },
  { name: "next day's slot fires again", run: () => { const s = new Schedule("t", "p", "0 9 * * *", T("2026-09-09T09:04:00Z"), null, T("2026-09-08T00:00:00Z")); return s.shouldRun(new Date("2026-09-10T09:00:00Z")) && s.dueAt === T("2026-09-10T09:00:00Z"); } },
  { name: "slot before the schedule was created never fires", run: () => { const s = new Schedule("t", "p", "0 9 * * *", null, null, T("2026-09-09T10:00:00Z")); return s.shouldRun(new Date("2026-09-09T12:00:00Z")) === false && s.shouldRun(new Date("2026-09-10T09:00:00Z")) === true; } },
  { name: "several missed */15 slots collapse into one run", run: () => { const s = new Schedule("t", "p", "*/15 * * * *", T("2026-09-09T08:00:10Z"), null, T("2026-09-08T00:00:00Z")); const a = s.shouldRun(new Date("2026-09-09T10:07:00Z")) && s.dueAt === T("2026-09-09T10:00:00Z"); s.lastRun = T("2026-09-09T10:07:00Z"); return a && s.shouldRun(new Date("2026-09-09T10:08:00Z")) === false && s.shouldRun(new Date("2026-09-09T10:15:00Z")) === true; } },
  { name: "slot older than the 24h window is not caught up", run: () => { const s = new Schedule("t", "p", "0 9 1 1 *", null, null, T("2025-01-01T00:00:00Z")); return s.shouldRun(new Date("2026-09-09T09:00:00Z")) === false; } },
  { name: "clock went backwards (lastRun in the future) does not refire", run: () => { const s = new Schedule("t", "p", "* * * * *", T("2026-09-09T10:00:00Z"), null, T("2026-09-08T00:00:00Z")); return s.shouldRun(new Date("2026-09-09T09:30:00Z")) === false; } },
  { name: "invalid cron never fires", run: () => new Schedule("t", "p", "0 9 * *", null, null, 1).shouldRun(new Date("2026-09-09T09:00:00Z")) === false && new Schedule("t", "p", "0 9 * *").lastDue() === null },
  { name: "manager: legacy entry without created is anchored on load and persisted", run: () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jam-sched-"));
    writeFileSync(path.join(dir, "scheduled.json"), JSON.stringify({ schedules: [{ room: "x", prompt: "p", when: "0 9 * * *", lastRun: null, tier: "medium" }] }));
    const before = Date.now(); const m = new ScheduleManager(dir); const s = m.all()[0];
    const onDisk = JSON.parse(readFileSync(path.join(dir, "scheduled.json"), "utf8")).schedules[0];
    const ok = s.created >= before && onDisk.created === s.created && onDisk.tier === "medium" && s.shouldRun(new Date(before)) === false; // yesterday's slot must not fire on upgrade
    rmSync(dir, { recursive: true, force: true }); return ok;
  } },
  { name: "manager: add() anchors created; checkAndMark persists lastRun and returns dueAt", run: () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jam-sched-")); const m = new ScheduleManager(dir);
    m.add("x", "p", "* * * * *"); const s = m.all()[0]; const ok1 = typeof s.created === "number";
    s.created = Date.now() - 120000; // pretend it was added two minutes ago
    const ran = m.checkAndMark(); const onDisk = JSON.parse(readFileSync(path.join(dir, "scheduled.json"), "utf8")).schedules[0];
    const ok = ok1 && ran.length === 1 && typeof ran[0].dueAt === "number" && onDisk.lastRun >= ran[0].dueAt && onDisk.dueAt === undefined && m.checkAndMark().length === 0;
    rmSync(dir, { recursive: true, force: true }); return ok;
  } },
];
// ── Olga's QA round (adab7ef): fail-closed parsing, validation, real-cron day semantics, robustness ──
const parse = (f, lo, hi) => Schedule.parseCronField(f, lo, hi);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
catchup.push(
  { name: "*/0 returns [] instead of looping", run: () => eq(parse("*/0", 0, 59), []) },
  { name: "*/7 gives bounded list", run: () => eq(parse("*/7", 0, 59), [0, 7, 14, 21, 28, 35, 42, 49, 56]) },
  { name: "garbage fields fail closed (never match), not open (match everything)", run: () => eq(parse("abc", 0, 59), []) && eq(parse("a-b", 0, 59), []) && eq(parse("5-3", 0, 59), []) && eq(parse("1,x", 0, 59), []) && eq(parse("99", 0, 59), []) && eq(parse("", 0, 59), []) },
  { name: "range with step and list", run: () => eq(parse("1-10/3", 0, 59), [1, 4, 7, 10]) && eq(parse("0,30,15", 0, 59), [0, 15, 30]) && eq(parse("5", 0, 59), [5]) },
  { name: "a schedule with garbage cron never fires", run: () => new Schedule("t", "p", "abc abc abc abc abc").shouldRun(new Date("2026-09-09T09:00:00Z")) === false },
  { name: "validate(): good crons pass, bad ones name the field", run: () => Schedule.validate("0 9 * * *") === null && Schedule.validate("*/15 * * * 1-5") === null && /minute/.test(Schedule.validate("*/0 9 * * *")) && /weekday/.test(Schedule.validate("0 9 * * 7")) && /5 fields/.test(Schedule.validate("0 9 * *")) && /hour/.test(Schedule.validate("0 24 * * *")) },
  { name: "day-of-month OR weekday when both restricted (real cron)", run: () => { const s = new Schedule("t", "p", "0 0 1 * 1"); return s.matches(new Date("2026-09-01T00:00:00Z")) && s.matches(new Date("2026-09-07T00:00:00Z")) && !s.matches(new Date("2026-09-02T00:00:00Z")); } },
  { name: "day-of-month alone / weekday alone still AND with the rest", run: () => new Schedule("t", "p", "0 0 5 * *").matches(new Date("2026-09-05T00:00:00Z")) && !new Schedule("t", "p", "0 0 5 * *").matches(new Date("2026-09-06T00:00:00Z")) && new Schedule("t", "p", "0 8 * * 5").matches(new Date("2026-09-04T08:00:00Z")) },
  { name: "string lastRun still blocks a refire (Number coercion)", run: () => new Schedule("t", "p", "0 9 * * *", String(T("2026-09-09T09:04:00Z")), null, 1).shouldRun(new Date("2026-09-09T09:05:00Z")) === false },
  { name: "one bad entry does not starve the rest of the tick", run: () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jam-sched-")); const m = new ScheduleManager(dir);
    m.add("bad", "p", "*/0 * * * *"); m.add("good", "p", "* * * * *"); for (const s of m.all()) s.created = Date.now() - 120000;
    const ran = m.checkAndMark(); rmSync(dir, { recursive: true, force: true }); return ran.length === 1 && ran[0].room === "good";
  } },
  { name: "backfill anchors at lastRun when an old writer dropped created (no skipped slot)", run: () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jam-sched-"));
    writeFileSync(path.join(dir, "scheduled.json"), JSON.stringify({ schedules: [{ room: "x", prompt: "p", when: "0 9 * * *", lastRun: T("2026-09-08T09:00:05Z") }] })); // old bridge ran the 8th, stripped created
    const m = new ScheduleManager(dir); const s = m.all()[0]; rmSync(dir, { recursive: true, force: true });
    return s.created === T("2026-09-08T09:00:05Z") && s.shouldRun(new Date("2026-09-09T09:05:00Z")) === true && s.dueAt === T("2026-09-09T09:00:00Z");
  } },
);
for (const t of catchup) {
  let ok = false, err = "";
  try { ok = t.run() === true; } catch (e) { err = e.message; }
  if (ok) { console.log(`✓ ${t.name}`); passed++; } else { console.log(`✗ ${t.name}${err ? " — " + err : ""}`); failed++; }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
