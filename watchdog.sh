#!/bin/bash
# jam bridge watchdog — the bridge (and even launchd's own KeepAlive) must not be the only thing standing between
# "a room looks idle" and someone noticing, eventually, that it's actually dead. 2026-09-29: the bridge crashed and
# launchd did NOT relaunch it on its own (launchctl showed it "not running" with no further attempts) until it was
# kickstarted by hand — nobody would have known otherwise. This runs on its own short interval, independent of the
# bridge's own launchd job, and answers two different questions with two different fixes:
#   1. Is a bridge process actually alive?            No  -> nudge launchd to (re)start it.
#   2. Is it alive but not actually connected to the hub (hung, wedged socket)?  -> a GRACEFUL kill (SIGTERM, never
#      -k/SIGKILL) so the shutdown handler in bridge.mjs gets a chance to requeue whatever turn is mid-flight before
#      launchd relaunches it fresh — SIGKILL cannot be caught and silently drops a live turn (found the same day,
#      when a manual `kickstart -k` dropped two of Mike's own turns with no error and no retry).
# A streak counter avoids reacting to one transient blip (a slow API response, a mid-restart moment).
# `./watchdog.sh --check` reports what it WOULD do without restarting or killing anything — use this to validate
# the script against the live bridge; the 2026-09-29 build of this file was tested without one and cost two
# unplanned restarts of the real production bridge purely from testing its own detection logic.
#
# This runs as ONE PERSISTENT LOOP (`./watchdog.sh`, no args), not a StartInterval job: launchd's own scheduler was
# found the same night to sit in "on-demand-only" mode for the whole per-user domain for 36+ hours (`launchctl print
# gui/<uid>` showed `on-demand count = 1`), during which a StartInterval=120 job fired exactly ONCE in over an hour.
# A loop inside an already-running process doesn't ask launchd to spawn anything new each cycle, the same reasoning
# behind run.sh now supervising bridge.mjs itself instead of `exec`ing into it and trusting KeepAlive alone.
if [ $# -eq 0 ]; then
  cd "$(dirname "$0")"
  trap 'exit 0' TERM INT
  while :; do
    "$0" --check-and-act
    sleep 120 &
    wait $!
  done
fi
DRY=0; [ "${1:-}" = "--check" ] && DRY=1
cd "$(dirname "$0")"
H=${JAM_HOST:-jam.nullagency.io}
LABEL="io.nullagency.jam"
UID_=$(id -u)
STATE=~/.jam/watchdog-state
LOCK=~/.jam/bridge-$(printf '%s' "$H" | tr -c 'A-Za-z0-9._-' '_').pid
mkdir -p logs
note() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> logs/watchdog.log; }
alert() { osascript -e "display notification \"$1\" with title \"jam watchdog\"" 2>/dev/null; }

PID=""
[ -f "$LOCK" ] && PID=$(cat "$LOCK" 2>/dev/null)
PROC_ALIVE=0
if [ -n "$PID" ] && ps -p "$PID" -o command= 2>/dev/null | grep -q "bridge.mjs"; then PROC_ALIVE=1; fi

if [ "$PROC_ALIVE" -eq 0 ]; then
  if [ "$DRY" -eq 1 ]; then echo "[--check] would treat this as DOWN (lock said pid $PID, not a live bridge.mjs) and kickstart launchd"; exit 0; fi
  note "no live bridge.mjs process (lock said pid $PID) — nudging launchd"
  launchctl kickstart "gui/$UID_/$LABEL" 2>>logs/watchdog.log
  sleep 5
  PID2=$(cat "$LOCK" 2>/dev/null)
  if [ -n "$PID2" ] && ps -p "$PID2" -o command= 2>/dev/null | grep -q "bridge.mjs"; then
    note "recovered: pid $PID2 running after plain kickstart"
    alert "The bridge had died and launchd hadn't relaunched it. Restarted — jam is back."
  else
    note "plain kickstart didn't bring it up — forcing with -k (nothing alive to interrupt)"
    launchctl kickstart -k "gui/$UID_/$LABEL" 2>>logs/watchdog.log
    alert "The bridge was dead and needed a forced restart. jam should be back now — worth a look."
  fi
  rm -f "$STATE"
  exit 0
fi

# A process exists — check the Worker's own live view of whether ANY bridge is actually connected to the hub. This
# is the exact signal the room UI's "bridge online/offline" badge uses, so it's what "is jam actually working right
# now" really means, not just "is there a node process".
ONLINE=$(curl -s --max-time 10 "https://$H/api/rooms?k=$(cat .jam-key 2>/dev/null)" 2>/dev/null | \
  node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(d);console.log(j.bridge?"1":"0")}catch{console.log("0")}})')

if [ "$ONLINE" = "1" ]; then
  [ "$DRY" -eq 1 ] && echo "[--check] healthy: process $PID alive, hub reports a bridge connected"
  [ "$DRY" -eq 1 ] || rm -f "$STATE"
  exit 0
fi

if [ "$DRY" -eq 1 ]; then echo "[--check] process $PID is alive; hub reports bridge NOT connected — a real run would count this toward a streak (currently $(cat "$STATE" 2>/dev/null || echo 0)) and act at 2"; exit 0; fi
STREAK=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$STREAK" > "$STATE"
note "process $PID alive but hub reports no bridge connected (streak $STREAK)"
if [ "$STREAK" -ge 2 ]; then
  note "graceful SIGTERM to pid $PID — bridge.mjs's own shutdown handler will requeue anything mid-flight"
  kill -TERM "$PID" 2>>logs/watchdog.log
  # KeepAlive relaunches it once it actually exits; give it a moment, then escalate only if it's truly wedged
  # (not honoring SIGTERM at all), which -k can't make worse since a graceful exit already had its chance.
  for i in 1 2 3 4 5 6; do sleep 5; ps -p "$PID" >/dev/null 2>&1 || break; done
  if ps -p "$PID" >/dev/null 2>&1; then
    note "pid $PID ignored SIGTERM for 30s — forcing with -k"
    launchctl kickstart -k "gui/$UID_/$LABEL" 2>>logs/watchdog.log
  fi
  alert "jam's bridge was up but not actually connected. Restarted it gracefully — check the rooms."
  rm -f "$STATE"
fi
