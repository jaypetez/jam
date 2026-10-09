// `bridge.mjs --list-schedules | --add-schedule room prompt cron [--tier t] | --remove-schedule room [cron]`, extracted from bridge.mjs
// (2026-10-09 review) so it can be tested without starting a bridge. Detected anywhere in argv (not just argv[2]) so a stray leading flag
// can never fall through into a full bridge start: a second bridge on the live room would race the real one for queued turns.
import { Schedule, ScheduleManager } from "./schedule.mjs";
import { globMatch } from "./room-dispatch.mjs";

const SCHED_CMDS = ["--list-schedules", "--add-schedule", "--remove-schedule"];
export const isScheduleCommand = argv => SCHED_CMDS.some(c => argv.includes(c));

// Returns null when argv is not a schedule command (the caller carries on and starts the bridge), else the process exit code.
export function runScheduleCli(argv, { stateDir, only = [], out = console.log, err = console.error }) {
  const scheduleCmd = SCHED_CMDS.find(c => argv.includes(c)) || null;
  if (!scheduleCmd) return null;
  const schedArgs = argv.slice(argv.indexOf(scheduleCmd) + 1);
  let schedTier = null;
  { const i = schedArgs.indexOf("--tier"); if (i >= 0) { schedTier = schedArgs[i + 1] ?? ""; schedArgs.splice(i, 2); } }
  if (scheduleCmd === "--list-schedules") {
    const sm = new ScheduleManager(stateDir);
    if (sm.all().length === 0) { out("No schedules."); return 0; }
    for (const s of sm.all()) out(`${s.room.padEnd(20)} ${s.prompt.slice(0, 50).padEnd(52)} ${s.when}${s.tier ? " [tier: " + s.tier + "]" : ""}`);
    return 0;
  }
  if (scheduleCmd === "--add-schedule") {
    const [room, prompt, cron] = schedArgs;
    if (!room || !prompt || !cron) { err("usage: --add-schedule <room> <prompt> <cron> [--tier light|medium|heavy]"); return 1; }
    const cronErr = Schedule.validate(cron); if (cronErr) { err(`invalid cron "${cron}": ${cronErr}`); return 1; }
    if (schedTier !== null && !["light", "medium", "heavy"].includes(schedTier)) { err("--tier must be light, medium, or heavy"); return 1; }
    // test-* rooms only open when --only is configured for them
    if (room.startsWith("test-")) {
      const willOpen = only.length ? only.some(p => globMatch(p, room)) : true;
      if (!willOpen) { err(`Cannot schedule for #${room}: bridge must be run with --only matching '${room}' (e.g. --only test-qa-* or --only ${room})`); return 1; }
    }
    new ScheduleManager(stateDir).add(room, prompt, cron, schedTier);
    out(`Added schedule for #${room}${schedTier ? ` (tier: ${schedTier})` : ""}`);
    return 0;
  }
  // --remove-schedule
  const [room, cron] = schedArgs;
  if (!room) { err("usage: --remove-schedule <room> [<cron>]"); return 1; }
  const sm = new ScheduleManager(stateDir);
  if (cron) { sm.removeByCron(room, cron); out(`Removed schedule for #${room} with cron ${cron}`); }
  else { sm.remove(room); out(`Removed all schedules for #${room}`); }
  return 0;
}
