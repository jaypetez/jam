#!/bin/bash
# Nightly gate for the scheduled #jam turn.
#
# Why this exists: the schedule used to be the natural-language prompt "run ./check.sh and ./run-tests.sh". Nothing
# machine-checked either exit code, so when 89ac9f8 dropped run-tests.sh's exec bit the suite failed with 126
# ("Permission denied", i.e. it never ran at all) every night and the turn reported nothing alarming. A gate whose
# result nobody asserts on is not a gate. This script collapses both runs into one verdict line and one exit code,
# and it calls out 126/127 separately because those mean "never ran", which is worse than "ran and failed".
#
# Usage: ./nightly.sh          exit 0 = everything green; non-zero = something to report.
# Logs:  logs/nightly-check.log, logs/nightly-tests.log (full output; the verdict line is the summary).
set -u
cd "$(dirname "$0")"
mkdir -p logs

# Scheduled turns inherit the live JAM_* env from the bridge, which makes test bridges talk to the real room.
# Strip it exactly the way the room notes require for any cold run of these scripts.
STRIP="env -u JAM_HOST -u JAM_KEY -u JAM_ROOM -u JAM_FROM -u JAM_FROM_ROLE -u JAM_TURN -u JAM_CWD"

# Describe an exit code in the terms that matter: did it run, and did it pass?
verdict() { # $1 = label, $2 = exit code
  case "$2" in
    0)   printf '%s ok' "$1" ;;
    126) printf '%s NEVER RAN (126 not executable - chmod +x, see the exec-bit guard in check.sh)' "$1" ;;
    127) printf '%s NEVER RAN (127 not found)' "$1" ;;
    *)   printf '%s FAILED (exit %s)' "$1" "$2" ;;
  esac
}

# No pipes around either run: a pipeline reports the LAST command's status and would hide exactly the failure
# this script exists to catch.
$STRIP ./check.sh > logs/nightly-check.log 2>&1
CHECK=$?

$STRIP ./run-tests.sh > logs/nightly-tests.log 2>&1
TESTS=$?

# The suite prints its own tally on the last line; carry it through so the verdict says what actually broke.
TALLY=$(grep -a '^tests done:' logs/nightly-tests.log | tail -1)
[ -n "$TALLY" ] || TALLY="no tally line - the suite did not reach the end"

echo "nightly: $(verdict check.sh "$CHECK"); $(verdict run-tests.sh "$TESTS") | $TALLY"

if [ "$CHECK" -ne 0 ] || [ "$TESTS" -ne 0 ]; then
  echo "--- tail of the failing log ---"
  [ "$CHECK" -ne 0 ] && tail -20 logs/nightly-check.log
  [ "$TESTS" -ne 0 ] && tail -20 logs/nightly-tests.log
  exit 1
fi
exit 0
