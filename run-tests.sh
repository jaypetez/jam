#!/bin/bash
# End-to-end tests against the live Worker. Creates test-* rooms (ignored by normal bridges), runs a dedicated
# bridge for them, executes test.mjs + test-upload.mjs, then cleans up. Usage: ./run-tests.sh
cd "$(dirname "$0")"; [ -f .env ] && set -a && . ./.env && set +a
K=$(cat .jam-key); H=${JAM_HOST:-jam.nullagency.io}; NODE=$(command -v node || echo /opt/homebrew/bin/node)
# http vs https for the curls below: same rule as jam-url.mjs (JAM_SCHEME wins; a loopback host is plain http; everything else TLS)
export JAM_HOST="$H"; HTTP=$("$NODE" -e 'const u=require("url"),p=require("path");import(u.pathToFileURL(p.resolve("jam-url.mjs")).href).then(m=>process.stdout.write(m.httpBase(process.env.JAM_HOST)))')
mkdir -p /tmp/jam-test-e2e /tmp/jam-test-upload /tmp/jam-test-compact /tmp/jam-test-status-bar /tmp/jam-test-statusbar-live /tmp/jam-test-reconnect /tmp/jam-test-boot /tmp/jam-test-cobrowse logs
# Wipe every test room BEFORE creating it. A suite aborted mid-run (killed poller, session boundary) leaves a queued
# "say" in the Room DO outbox; the next run's bridge replays it, so the room gets two turns and the reconnect test
# reports "exactly one reply bubble (got 2)". Delete wipes log+outbox+meta; a 404 on a missing room is harmless.
for r in test-e2e test-upload test-compact test-status-bar test-statusbar-live test-reconnect test-qa-boot-feature test-cobrowse test-switch test-auth test-runlocal; do curl -s -X DELETE "$HTTP/api/rooms/$r?k=$K" >/dev/null; done
curl -s -X POST "$HTTP/api/rooms?k=$K" -d '{"name":"test-e2e","cwd":"/tmp/jam-test-e2e"}' >/dev/null
curl -s -X POST "$HTTP/api/rooms?k=$K" -d '{"name":"test-upload","cwd":"/tmp/jam-test-upload"}' >/dev/null
curl -s -X POST "$HTTP/api/rooms?k=$K" -d '{"name":"test-compact","cwd":"/tmp/jam-test-compact"}' >/dev/null
curl -s -X POST "$HTTP/api/rooms?k=$K" -d '{"name":"test-status-bar","cwd":"/tmp/jam-test-status-bar"}' >/dev/null
curl -s -X POST "$HTTP/api/rooms?k=$K" -d '{"name":"test-statusbar-live","cwd":"/tmp/jam-test-statusbar-live"}' >/dev/null
curl -s -X POST "$HTTP/api/rooms?k=$K" -d '{"name":"test-reconnect","cwd":"/tmp/jam-test-reconnect"}' >/dev/null
curl -s -X POST "$HTTP/api/rooms?k=$K" -d '{"name":"test-qa-boot-feature","cwd":"/tmp/jam-test-boot"}' >/dev/null
curl -s -X POST "$HTTP/api/rooms?k=$K" -d '{"name":"test-cobrowse","cwd":"/tmp/jam-test-cobrowse"}' >/dev/null
rm -f ~/.jam/sessions/test-e2e.json ~/.jam/sessions/test-upload.json ~/.jam/sessions/test-compact.json ~/.jam/sessions/test-compact.seed.md ~/.jam/sessions/test-status-bar.json ~/.jam/sessions/test-statusbar-live.json ~/.jam/sessions/test-reconnect.json ~/.jam/sessions/test-qa-boot-feature.json ~/.jam/sessions/test-cobrowse.json; rm -rf ~/.jam/browser/test-cobrowse
JAM_ONLY=test-e2e,test-upload,test-compact,test-status-bar,test-statusbar-live,test-reconnect,test-qa-boot-feature,test-cobrowse JAM_CATALOG=off "$NODE" bridge.mjs > logs/test-bridge.log 2>&1 & BR=$!
sleep 4
# A pipeline's exit code is its LAST command's (the `grep` filter here), never the test's — a test that crashes
# outright with no literal "FAIL" line would exit this script 0 with the crash silently swallowed. PIPESTATUS[0] is
# the actual test process's exit code; append a synthetic FAIL line to its own log when that's nonzero, so the tally
# below and the exit gate at the bottom both still catch it (2026-09-29: found on the auth suite, applied to all).
K=$K JAM_HOST=$H "$NODE" test.mjs 2>&1 | tee logs/test-e2e.log | grep -E "^FAIL|failures|Error"; [ ${PIPESTATUS[0]} -eq 0 ] || echo "FAIL test.mjs exited ${PIPESTATUS[0]}" >> logs/test-e2e.log
K=$K JAM_HOST=$H "$NODE" test-upload.mjs 2>&1 | tee logs/test-upload.log | grep -E "^FAIL|PASS claude|Error"; [ ${PIPESTATUS[0]} -eq 0 ] || echo "FAIL test-upload.mjs exited ${PIPESTATUS[0]}" >> logs/test-upload.log
K=$K JAM_HOST=$H ROOM=test-compact "$NODE" compact.test.mjs 2>&1 | tee logs/test-compact.log | grep -E "^FAIL|^PASS|Error"; [ ${PIPESTATUS[0]} -eq 0 ] || echo "FAIL compact.test.mjs exited ${PIPESTATUS[0]}" >> logs/test-compact.log
K=$K JAM_HOST=$H ROOM=test-status-bar "$NODE" test-status-bar.mjs 2>&1 | tee logs/test-status-bar.log | grep -E "^FAIL|^PASS|Error"; [ ${PIPESTATUS[0]} -eq 0 ] || echo "FAIL test-status-bar.mjs exited ${PIPESTATUS[0]}" >> logs/test-status-bar.log
if [ -d node_modules/playwright ]; then
  K=$K JAM_HOST=$H ROOM=test-reconnect "$NODE" reconnect.test.mjs 2>&1 | tee logs/test-reconnect.log | grep -E "^FAIL|^PASS|Error"; [ ${PIPESTATUS[0]} -eq 0 ] || echo "FAIL reconnect.test.mjs exited ${PIPESTATUS[0]}" >> logs/test-reconnect.log
  K=$K JAM_HOST=$H ROOM=test-statusbar-live "$NODE" test-statusbar-live.mjs 2>&1 | tee logs/test-statusbar-live.log | grep -E "^FAIL|^PASS|Error"; [ ${PIPESTATUS[0]} -eq 0 ] || echo "FAIL test-statusbar-live.mjs exited ${PIPESTATUS[0]}" >> logs/test-statusbar-live.log
  K=$K JAM_HOST=$H "$NODE" test-boot.mjs 2>&1 | tee logs/test-boot.log | grep -E "^FAIL|^PASS|Error"; [ ${PIPESTATUS[0]} -eq 0 ] || echo "FAIL test-boot.mjs exited ${PIPESTATUS[0]}" >> logs/test-boot.log
  K=$K JAM_HOST=$H ROOM=test-cobrowse "$NODE" test-cobrowse.mjs 2>&1 | tee logs/test-cobrowse.log | grep -E "^FAIL|^PASS|Error"; [ ${PIPESTATUS[0]} -eq 0 ] || echo "FAIL test-cobrowse.mjs exited ${PIPESTATUS[0]}" >> logs/test-cobrowse.log
else echo "ERROR: playwright not installed. Run: npm i" >&2 | tee logs/test-reconnect.log logs/test-statusbar-live.log logs/test-boot.log logs/test-cobrowse.log; exit 1; fi
kill $BR 2>/dev/null
# host login gets its own bridge with a stub `claude` (auth.test.mjs): the real `claude auth login` opens a browser
# and rewrites the host's credentials, which a test must never touch
mkdir -p /tmp/jam-test-auth; echo '{"loggedIn":false}' > /tmp/jam-test-auth-state.json
curl -s -X POST "$HTTP/api/rooms?k=$K" -d '{"name":"test-auth","cwd":"/tmp/jam-test-auth"}' >/dev/null
rm -f /tmp/jam-test-auth-count; chmod +x test-auth-claude-stub.mjs
JAM_ONLY=test-auth JAM_CLAUDE="$PWD/test-auth-claude-stub.mjs" JAM_AUTH_STATE=/tmp/jam-test-auth-state.json JAM_AUTH_GOOD_CODE=good-code JAM_AUTH_COUNT=/tmp/jam-test-auth-count JAM_CATALOG=off "$NODE" bridge.mjs > logs/test-bridge-auth.log 2>&1 & BR=$!
sleep 4
K=$K JAM_HOST=$H ROOM=test-auth JAM_AUTH_GOOD_CODE=good-code JAM_AUTH_COUNT=/tmp/jam-test-auth-count "$NODE" auth.test.mjs 2>&1 | tee logs/test-auth.log | grep -E "^FAIL|^PASS|Error"; [ ${PIPESTATUS[0]} -eq 0 ] || echo "FAIL auth.test.mjs exited ${PIPESTATUS[0]}" >> logs/test-auth.log
kill $BR 2>/dev/null; curl -s -X DELETE "$HTTP/api/rooms/test-auth?k=$K" >/dev/null; rm -f ~/.jam/sessions/test-auth.json /tmp/jam-test-auth-state.json
# "Run commands on this machine": its own bridge with a stub `claude` that runs the real approve hook with the env the bridge gave it
# (runlocal.test.mjs) -- the only test that covers settings -> hub -> bridge cfg -> spawn env -> hook end to end.
mkdir -p /tmp/jam-test-runlocal
curl -s -X POST "$HTTP/api/rooms?k=$K" -d '{"name":"test-runlocal","cwd":"/tmp/jam-test-runlocal"}' >/dev/null
chmod +x test-runlocal-claude-stub.mjs
JAM_ONLY=test-runlocal JAM_CLAUDE="$PWD/test-runlocal-claude-stub.mjs" JAM_CATALOG=off "$NODE" bridge.mjs > logs/test-bridge-runlocal.log 2>&1 & BR=$!
sleep 4
K=$K JAM_HOST=$H ROOM=test-runlocal "$NODE" runlocal.test.mjs 2>&1 | tee logs/test-runlocal.log | grep -E "^FAIL|^PASS|Error"; [ ${PIPESTATUS[0]} -eq 0 ] || echo "FAIL runlocal.test.mjs exited ${PIPESTATUS[0]}" >> logs/test-runlocal.log
kill $BR 2>/dev/null; curl -s -X DELETE "$HTTP/api/rooms/test-runlocal?k=$K" >/dev/null; rm -f ~/.jam/sessions/test-runlocal.json
# model switching gets its own bridge: it starts Haiku + Fable capped and shrinks Sonnet's window (test hooks)
mkdir -p /tmp/jam-test-switch; rm -f ~/.jam/sessions/test-switch*
curl -s -X POST "$HTTP/api/rooms?k=$K" -d '{"name":"test-switch","cwd":"/tmp/jam-test-switch"}' >/dev/null
JAM_ONLY=test-switch JAM_CAPPED=claude-haiku-4-5-20251001,claude-opus-5 JAM_WINDOWS='{"claude-sonnet-5":20000}' JAM_CATALOG=off "$NODE" bridge.mjs > logs/test-bridge-switch.log 2>&1 & BR=$!
sleep 4
K=$K JAM_HOST=$H ROOM=test-switch "$NODE" switch.test.mjs 2>&1 | tee logs/test-switch.log | grep -E "^FAIL|^PASS|Error"; [ ${PIPESTATUS[0]} -eq 0 ] || echo "FAIL switch.test.mjs exited ${PIPESTATUS[0]}" >> logs/test-switch.log
kill $BR 2>/dev/null; rm -rf ~/.jam/sessions/test-switch*
JAM_ONLY=test-switch JAM_CAPPED=claude-haiku-4-5-20251001,claude-sonnet-5,claude-opus-5 JAM_CATALOG=off "$NODE" bridge.mjs > logs/test-bridge-switch2.log 2>&1 & BR=$!
sleep 4
K=$K JAM_HOST=$H ROOM=test-switch ALL_CAPPED=1 "$NODE" switch.test.mjs 2>&1 | tee -a logs/test-switch.log | grep -E "^FAIL|^PASS|Error"; [ ${PIPESTATUS[0]} -eq 0 ] || echo "FAIL switch.test.mjs (ALL_CAPPED) exited ${PIPESTATUS[0]}" >> logs/test-switch.log
kill $BR 2>/dev/null; curl -s -X DELETE "$HTTP/api/rooms/test-switch?k=$K" >/dev/null; rm -rf ~/.jam/sessions/test-switch*
curl -s -X DELETE "$HTTP/api/rooms/test-e2e?k=$K" >/dev/null; curl -s -X DELETE "$HTTP/api/rooms/test-upload?k=$K" >/dev/null; curl -s -X DELETE "$HTTP/api/rooms/test-compact?k=$K" >/dev/null; curl -s -X DELETE "$HTTP/api/rooms/test-status-bar?k=$K" >/dev/null; curl -s -X DELETE "$HTTP/api/rooms/test-statusbar-live?k=$K" >/dev/null; curl -s -X DELETE "$HTTP/api/rooms/test-reconnect?k=$K" >/dev/null; curl -s -X DELETE "$HTTP/api/rooms/test-qa-boot-feature?k=$K" >/dev/null; curl -s -X DELETE "$HTTP/api/rooms/test-cobrowse?k=$K" >/dev/null
rm -rf ~/.jam/uploads/test-upload ~/.jam/sessions/test-e2e.json ~/.jam/sessions/test-upload.json ~/.jam/sessions/test-compact* ~/.jam/sessions/test-status-bar.json ~/.jam/sessions/test-statusbar-live.json ~/.jam/sessions/test-reconnect.json ~/.jam/sessions/test-qa-boot-feature.json ~/.jam/sessions/test-cobrowse.json ~/.jam/browser/test-cobrowse ~/.jam/uploads/test-cobrowse
"$NODE" test-single-bridge.mjs > logs/test-single-bridge.log 2>&1 || echo "FAIL single-bridge guard (see logs/test-single-bridge.log)" >> logs/test-single-bridge.log
echo "tests done: $(grep -c '^PASS' logs/test-e2e.log) e2e PASS, $(grep -c '^FAIL' logs/test-e2e.log) FAIL; upload $(grep -c '^PASS' logs/test-upload.log) PASS $(grep -c '^FAIL' logs/test-upload.log) FAIL; status-bar $(grep -c '^PASS' logs/test-status-bar.log) PASS $(grep -c '^FAIL' logs/test-status-bar.log) FAIL; statusbar-live $(grep -c '^PASS' logs/test-statusbar-live.log) PASS $(grep -c '^FAIL' logs/test-statusbar-live.log) FAIL; reconnect $(grep -c '^PASS' logs/test-reconnect.log) PASS $(grep -c '^FAIL' logs/test-reconnect.log) FAIL; boot $(grep -c '^PASS' logs/test-boot.log) PASS $(grep -c '^FAIL' logs/test-boot.log) FAIL; cobrowse $(grep -c '^PASS' logs/test-cobrowse.log) PASS $(grep -c '^FAIL' logs/test-cobrowse.log) FAIL; compact $(grep -c '^PASS' logs/test-compact.log) PASS $(grep -c '^FAIL' logs/test-compact.log) FAIL; switch $(grep -c '^PASS' logs/test-switch.log) PASS $(grep -c '^FAIL' logs/test-switch.log) FAIL; auth $(grep -c '^PASS' logs/test-auth.log) PASS $(grep -c '^FAIL' logs/test-auth.log) FAIL; runlocal $(grep -c '^PASS' logs/test-runlocal.log) PASS $(grep -c '^FAIL' logs/test-runlocal.log) FAIL"
# Exit non-zero when any test failed so cron/CI can trust the exit code (it was always 0, which hid failures).
grep -q '^FAIL' logs/test-*.log && exit 1
exit 0
