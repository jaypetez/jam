#!/bin/bash
# Start the jam bridge on this machine. Reads .env (JAM_HOST, JAM_KEY optional) and .jam-key.
cd "$(dirname "$0")"
# `claude auth status`'s Keychain lookup silently reports signed-out when USER is missing from the environment —
# verified 2026-09-29 by reproducing it with `env -i HOME=... PATH=... claude auth status` (loggedIn:false) vs the
# same call with USER added (loggedIn:true). launchd's LaunchAgent EnvironmentVariables does NOT set USER or LOGNAME
# (confirmed with `launchctl print`) — a real turn's own spawn happens to still authenticate through a different
# path, so this only ever showed up as a false "signed out" card, never as broken turns. This line alone fixes it;
# don't also add USER/LOGNAME to the plist (redundant, and it can drift from this file — 2026-09-29 lesson).
export USER="${USER:-$(id -un)}" LOGNAME="${LOGNAME:-$(id -un)}"
# Only JAM_* settings come from .env, and never JAM_KEY: the bridge reads .jam-key itself. Anything else in .env (Cloudflare credentials, for
# deploy.sh, which sources .env on its own) must not sit in the environment of the bridge and every claude it spawns, where any same-uid
# process can read it back with sysctl.
if [ -f .env ]; then
  while IFS='=' read -r k v; do
    case "$k" in JAM_KEY) ;; JAM_[A-Z_]*) v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"; export "$k=$v";; esac
  done < .env
fi
NODE=$(command -v node || ls /opt/homebrew/bin/node /usr/local/bin/node 2>/dev/null | head -1)
[ -z "$NODE" ] && { echo "node not found; install Node 18+ (brew install node)"; exit 1; }
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
# bridge.mjs watches its own source and exits 0 to pick up new code once every room is idle; launchd's KeepAlive is
# supposed to relaunch it (or any real crash) but was found 2026-09-29/30 sitting in "on-demand-only" mode for the
# per-user launchd domain for 36+ hours straight (`launchctl print gui/<uid>` showed `on-demand count = 1`) — every
# recovery that night was a manual `launchctl kickstart`, including one ordinary self-restart that cost 53 minutes
# of downtime nobody noticed until asked. A loop in an ALREADY-RUNNING process doesn't need launchd to spawn
# anything new, so this supervises the child itself and survives launchd being stuck exactly that way. Previously
# `exec`d into node directly, making it a direct child of launchd (ppid 1) — bridge.mjs used that ppid to decide
# whether to watch its own files for a self-restart; now that node is a child of THIS loop instead, JAM_AUTORESTART
# says the same thing explicitly.
export JAM_AUTORESTART=1
stop=0
on_signal() { stop=1; [ -n "$child" ] && kill -"$1" "$child" 2>/dev/null; }
trap 'on_signal TERM' TERM
trap 'on_signal INT' INT
while :; do
  started=$(date +%s)
  "$NODE" bridge.mjs "$@" &
  child=$!
  wait "$child"
  code=$?
  [ "$stop" -eq 1 ] && exit "$code"
  ran=$(( $(date +%s) - started ))
  [ "$ran" -lt 3 ] && sleep 5 # crash-loop backoff, matching the old plist's ThrottleInterval intent
  echo "$(date -u +%H:%M:%S) run.sh: bridge exited $code — relaunching without waiting on launchd" >> logs/bridge.log
done
