// schedule.mjs — manage recurring prompts for jam rooms.
// Cron expressions follow the standard 5-field format: minute hour day month weekday
// Examples: "0 8 * * *" (daily at 8am), "*/15 * * * *" (every 15 minutes)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export const CATCHUP_MS = 24 * 3600 * 1000; // how far back a missed slot is still worth running

export class Schedule {
  constructor(room, prompt, when, lastRun = null, tier = null, created = null) {
    this.room = room;
    this.prompt = prompt;
    this.when = when; // cron expression
    this.lastRun = lastRun; // timestamp of last execution
    this.tier = tier; // optional: "light", "medium", "heavy", or null for auto-route
    this.created = created; // timestamp the schedule was added; slots before it never fire (null = no anchor)
  }

  // Parse a cron field. Returns null for "*" (any), else the sorted list of allowed values. Anything malformed
  // (step 0, reversed range, non-numbers, out-of-range values) returns [] so it can never match: fail closed, never open.
  static parseCronField(field, min, max) {
    if (field === "*") return null; // any
    const num = t => (/^\d+$/.test(t) ? parseInt(t, 10) : NaN);
    const inRange = v => Number.isInteger(v) && v >= min && v <= max;
    let out = [];
    for (const part of field.split(",")) {
      const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
      if (!m) return [];
      const step = m[2] === undefined ? 1 : num(m[2]);
      if (!(step >= 1)) return [];
      let a = min, b = max;
      if (m[1] !== "*") { const [x, y] = m[1].split("-"); a = num(x); b = y === undefined ? (m[2] === undefined ? a : max) : num(y); }
      if (!inRange(a) || !inRange(b) || a > b) return [];
      for (let i = a; i <= b; i += step) out.push(i);
    }
    return [...new Set(out)].sort((x, y) => x - y);
  }

  // null when the expression is valid, else a short reason (used by --add-schedule to reject bad crons up front)
  // Special case: "now" means fire immediately on next check, then never again.
  static validate(when) {
    when = String(when || "").trim();
    if (when === "now") return null; // valid: fire immediately
    const parts = when.split(/\s+/);
    if (parts.length !== 5) return "cron needs 5 fields: minute hour day month weekday";
    const names = ["minute", "hour", "day", "month", "weekday"], lo = [0, 0, 1, 1, 0], hi = [59, 23, 31, 12, 6];
    for (let i = 0; i < 5; i++) { const f = Schedule.parseCronField(parts[i], lo[i], hi[i]); if (f && !f.length) return `bad ${names[i]} field "${parts[i]}"`; }
    return null;
  }

  // Parse all five fields once (null = any)
  fields() {
    const parts = this.when.split(/\s+/);
    if (parts.length !== 5) return null; // invalid cron
    const [minStr, hourStr, dayStr, monthStr, wdayStr] = parts;
    return {
      min: Schedule.parseCronField(minStr, 0, 59),
      hour: Schedule.parseCronField(hourStr, 0, 23),
      day: Schedule.parseCronField(dayStr, 1, 31),
      month: Schedule.parseCronField(monthStr, 1, 12),
      wday: Schedule.parseCronField(wdayStr, 0, 6),
    };
  }

  static matchesFields(f, d) {
    // day-of-month and weekday: like real cron, when BOTH are restricted a date matches if EITHER does
    const dayOk = !f.day || f.day.includes(d.getUTCDate());
    const wdayOk = !f.wday || f.wday.includes(d.getUTCDay()); // 0 = Sunday
    const dateOk = f.day && f.wday ? dayOk || wdayOk : dayOk && wdayOk;
    return (!f.min || f.min.includes(d.getUTCMinutes())) &&
      (!f.hour || f.hour.includes(d.getUTCHours())) &&
      (!f.month || f.month.includes(d.getUTCMonth() + 1)) && // JS months are 0-based
      dateOk;
  }

  // Pure cron match: does this minute match the expression? (UTC)
  // Special case: "now" always matches (but shouldRun() ensures it fires only once).
  matches(now = new Date()) {
    if (this.when === "now") return true; // always matches
    const f = this.fields();
    return f ? Schedule.matchesFields(f, now) : false;
  }

  // Most recent matching minute at or before `now`, looking back at most `windowMs` (default 24h). Returns a Date at the
  // start of that minute, or null. Scans minute by minute; 1440 cheap checks worst case.
  // Special case: "now" is always due at the current time.
  lastDue(now = new Date(), windowMs = CATCHUP_MS) {
    if (this.when === "now") return now; // due right now
    const f = this.fields();
    if (!f) return null;
    const floor = Math.floor(now.getTime() / 60000) * 60000;
    for (let t = floor; t >= floor - windowMs; t -= 60000) {
      const d = new Date(t);
      if (Schedule.matchesFields(f, d)) return d;
    }
    return null;
  }

  // Should the schedule run at `now`? True when the most recent due slot (within the catch-up window) has not run yet
  // and postdates the schedule's creation. So a slot the bridge slept or was down through still fires once, at the next
  // tick after wake-up; several missed slots collapse into one run; slots before the schedule existed never fire.
  // "now" is a one-shot: lastDue("now") returns the current instant on every call, which is always later than a fixed
  // lastRun timestamp, so the dueAt comparison below never sees "already ran" — it fired every 60s forever until removed
  // (found live 2026-09-11: a "now" schedule re-queued the same prompt every check). Short-circuit it here instead.
  shouldRun(now = new Date()) {
    if (this.when === "now") return !this.lastRun;
    const due = this.lastDue(now);
    if (!due) return false;
    const dueAt = due.getTime();
    const lastRun = Number(this.lastRun) || 0, created = Number(this.created) || 0; // tolerate hand-edited strings
    if (lastRun >= dueAt) return false; // already ran this slot (or clock went backwards)
    if (created > dueAt) return false; // slot predates the schedule
    this.dueAt = dueAt; // transient, for the caller's log line; not persisted
    return true;
  }

  markRun() {
    this.lastRun = Date.now();
  }
}

export class ScheduleManager {
  constructor(stateDir = path.join(os.homedir(), ".jam")) {
    this.stateDir = stateDir;
    this.file = path.join(stateDir, "scheduled.json");
    this.schedules = [];
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      let backfilled = false;
      this.schedules = (data.schedules || []).map(s => {
        // Entry without a `created` anchor (written before this field existed, or by an older bridge that dropped it):
        // anchor at its last run if it has one — the schedule certainly existed then, so every later slot stays eligible —
        // else at now, so a slot that passed before the schedule was known does not fire.
        if (!s.created) backfilled = true;
        return new Schedule(s.room, s.prompt, s.when, s.lastRun, s.tier, s.created || s.lastRun || Date.now());
      });
      if (backfilled) this.save();
    } catch {
      this.schedules = [];
    }
  }

  save() {
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(
      this.file,
      JSON.stringify(
        {
          schedules: this.schedules.map(s => ({
            room: s.room,
            prompt: s.prompt,
            when: s.when,
            lastRun: s.lastRun,
            created: s.created,
            ...(s.tier && { tier: s.tier }),
          })),
        },
        null,
        1
      )
    );
  }

  add(room, prompt, when, tier = null) {
    this.schedules.push(new Schedule(room, prompt, when, null, tier, Date.now()));
    this.save();
  }

  remove(room) {
    const before = this.schedules.length;
    this.schedules = this.schedules.filter(s => s.room !== room);
    if (this.schedules.length < before) this.save();
  }

  removeByCron(room, cron) {
    const before = this.schedules.length;
    this.schedules = this.schedules.filter(s => !(s.room === room && s.when === cron));
    if (this.schedules.length < before) this.save();
  }

  // Find schedules that should run now and mark them
  checkAndMark() {
    const now = new Date();
    const toRun = this.schedules.filter(s => { try { return s.shouldRun(now); } catch { return false; } }); // one bad entry never starves the rest
    for (const s of toRun) s.markRun();
    if (toRun.length) this.save();
    return toRun;
  }

  getForRoom(room) {
    return this.schedules.filter(s => s.room === room);
  }

  all() {
    return [...this.schedules];
  }
}
