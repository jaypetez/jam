#!/usr/bin/env node
// Unit tests for schedule-cli.mjs against a throwaway state dir. Plain Node, no framework (see CLAUDE.md).
import { runScheduleCli, isScheduleCommand } from "./schedule-cli.mjs";
import { ScheduleManager } from "./schedule.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
let pass = 0, fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } };

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "schedcli-"));
const run = (argv, only = []) => { const out = [], err = []; const code = runScheduleCli(argv, { stateDir, only, out: s => out.push(s), err: s => err.push(s) }); return { code, out, err }; };

eq("not a schedule command → null (the bridge starts normally)", run(["node", "bridge.mjs", "--host", "x"]).code, null);
eq("isScheduleCommand finds the flag anywhere in argv (a stray leading flag must not start a bridge)", [isScheduleCommand(["a", "--only", "x", "--list-schedules"]), isScheduleCommand(["a"])], [true, false]);
eq("empty list", run(["n", "b", "--list-schedules"]), { code: 0, out: ["No schedules."], err: [] });

let r = run(["n", "b", "--add-schedule", "jam", "nightly check", "0 8 * * *", "--tier", "light"]);
eq("add with a tier", [r.code, r.out], [0, ["Added schedule for #jam (tier: light)"]]);
eq("…is persisted", new ScheduleManager(stateDir).all().map(s => [s.room, s.prompt, s.when, s.tier]), [["jam", "nightly check", "0 8 * * *", "light"]]);
r = run(["n", "b", "--add-schedule", "jam", "again", "*/15 * * * *"]); eq("add without a tier", [r.code, r.out], [0, ["Added schedule for #jam"]]);
r = run(["n", "b", "--list-schedules"]); eq("list shows both, with the tier tag", [r.code, r.out.length, r.out[0].includes("[tier: light]"), r.out[1].includes("[tier:")], [0, 2, true, false]);

eq("add needs all three args", run(["n", "b", "--add-schedule", "jam", "p"]), { code: 1, out: [], err: ["usage: --add-schedule <room> <prompt> <cron> [--tier light|medium|heavy]"] });
eq("add rejects a bad cron up front", run(["n", "b", "--add-schedule", "jam", "p", "61 * * * *"]).err[0], 'invalid cron "61 * * * *": bad minute field "61"');
eq("add rejects a bad tier (and an empty one)", [run(["n", "b", "--add-schedule", "jam", "p", "now", "--tier", "huge"]).err[0], run(["n", "b", "--add-schedule", "jam", "p", "now", "--tier"]).err[0]], ["--tier must be light, medium, or heavy", "--tier must be light, medium, or heavy"]);
eq("a bad add changes nothing", new ScheduleManager(stateDir).all().length, 2);

// test-* rooms need a matching --only
r = run(["n", "b", "--add-schedule", "test-qa-1", "p", "now"], ["jam"]); eq("test-* room with a non-matching --only is refused", [r.code, r.err[0].startsWith("Cannot schedule for #test-qa-1")], [1, true]);
eq("…allowed when --only matches", run(["n", "b", "--add-schedule", "test-qa-1", "p", "now"], ["test-qa-*"]).code, 0);
eq("…and (existing behaviour) allowed with no --only at all", run(["n", "b", "--add-schedule", "test-x", "p", "now"]).code, 0);

eq("remove by cron", [run(["n", "b", "--remove-schedule", "jam", "*/15 * * * *"]).out, new ScheduleManager(stateDir).getForRoom("jam").length], [["Removed schedule for #jam with cron */15 * * * *"], 1]);
eq("remove all for a room", [run(["n", "b", "--remove-schedule", "jam"]).out, new ScheduleManager(stateDir).getForRoom("jam").length], [["Removed all schedules for #jam"], 0]);
eq("remove needs a room", run(["n", "b", "--remove-schedule"]), { code: 1, out: [], err: ["usage: --remove-schedule <room> [<cron>]"] });

fs.rmSync(stateDir, { recursive: true, force: true });
console.log(`schedule-cli: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
