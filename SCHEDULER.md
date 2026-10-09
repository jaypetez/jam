# Jam Scheduler — Recurring Automated Turns

The scheduler allows you to define recurring prompts that run automatically on a cron-like schedule, integrated directly into the bridge's main loop.

## Quick Start

Add a daily regression check at 09:00 UTC:
```bash
node bridge.mjs --add-schedule jam "run ./check.sh and ./run-tests.sh" "0 9 * * *"
```

Pin a schedule to a model tier (skips auto-routing; `light` = Haiku 4.5, `medium` = Sonnet 5, `heavy` = Fable 5.1):
```bash
node bridge.mjs --add-schedule jam "run ./check.sh and ./run-tests.sh" "0 9 * * *" --tier medium
```

List all schedules:
```bash
node bridge.mjs --list-schedules
```

Remove a specific schedule:
```bash
node bridge.mjs --remove-schedule jam "0 9 * * *"
```

Remove all schedules for a room:
```bash
node bridge.mjs --remove-schedule jam
```

## How It Works

1. **Persistence**: Schedules are persisted in `~/.jam/scheduled.json`
2. **Checking**: Bridge ticks once just after every minute boundary. A slot the machine slept through (or the bridge was down for) is **caught up**: at the next tick the most recent due slot within 24h that has not run yet fires once. Several missed slots collapse into one run; slots older than the schedule itself never fire
3. **Execution**: Matching schedules are queued as messages in the room (like any other turn)
4. **Routing**: Scheduled turns are marked with `role: "scheduler"` and are floored to **medium tier** (Sonnet 5): the prompt is scored as usual, then raised to medium if it came out light. A `--tier` pin replaces the scoring entirely. Two guards apply even to pinned turns: a crash retry escalates one tier, and a session whose context is past the small models' window always runs on Fable
5. **Visibility**: Failed scheduled turns alert in-room with a `⚠️` warning
6. **Limitations**: 
   - Scheduled turns only fire if the **room already exists**
   - Test rooms (`test-*`) are skipped unless the bridge runs with `--only`

## Cron Format

5-field format (minute hour day month weekday), using UTC:
- `0 9 * * *` — daily at 09:00 UTC
- `*/15 * * * *` — every 15 minutes
- `0 */6 * * *` — every 6 hours
- `0 8 * * 1-5` — weekdays at 08:00 UTC
- `0,30 * * * *` — every 30 minutes (at :00 and :30)
- `0 0 1 * 1` — midnight on the 1st **or** on any Monday (when both day-of-month and weekday are restricted, either matching counts, as in real cron)

`--add-schedule` rejects malformed expressions (`*/0`, `5-3`, `abc`, out-of-range values, wrong field count) and names the bad field. A malformed expression that reaches the file anyway never matches; it cannot fire every minute and cannot block other schedules.

## Best Practices

1. **One prompt per schedule** — Keep scheduled prompts focused and atomic
2. **Expect failures** — Scheduled turns can error (network, timeout); add retry logic in the prompt if needed
3. **UTC times only** — All times are UTC; document times as UTC when telling humans
4. **Room must exist** — Create the room or ensure users have joined before a scheduled turn runs
5. **Not for live-critical work** — Scheduled turns are best for automation, monitoring, and tests, not for user-facing features
6. **Test the cron expression** — Use `node schedule.test.mjs` to verify your expression before deploying

## Monitoring

Scheduled turn execution is logged to `logs/bridge.log`:
```
07:39:29 #jam scheduled turn queued
07:39:30 #jam route → medium (2) scheduled automation
07:39:30 #jam turn 12ab34cd (resume) from scheduler scheduler
```

Failed runs appear as:
```
07:45:15 #jam route → medium (2) scheduled automation
07:45:15 #jam turn 56ef78gh (resume) from scheduler scheduler
07:45:21 #jam done 56ef78gh ERROR
07:45:21 #jam scheduled turn error 1
⚠️ Scheduled turn failed: exit code 1
```

## Implementation Notes

- Scheduler is bridge-side only (not in the worker)
- No queue persistence across bridge restarts (turns are re-queued at next interval)
- Each due slot runs at most once (`lastRun` is compared with the slot's start minute, not with "now minus 60s")
- `created` (persisted) anchors a schedule: a slot that passed before it was added is not a missed slot. Entries written before this field existed get anchored the first time the bridge loads them
- Catch-up window is 24h (`CATCHUP_MS` in `schedule.mjs`); a laptop that sleeps overnight at 09:00 UTC runs the check on wake and logs `scheduled turn queued (catch-up: due 09:00 UTC, 361 min late)`
- Failures don't auto-retry; add retry logic to your prompt if needed
- Ticks are aligned to the minute, so an exact-minute slot normally fires within ~1s of it

## Future Improvements

- [ ] Retry logic for transient failures
- [ ] UI indicator for which rooms have schedules
- [ ] Next run time prediction in the UI
- [ ] Schedule-specific retry and timeout policies
- [ ] Notification alerts (Slack, email) for repeated failures
