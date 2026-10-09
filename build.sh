#!/bin/bash
set -e
cd "$(dirname "$0")"
# inline-modules.txt is the single list of modules inlined into the Worker: the build hash and the bundle are both derived from it
# (the hash used to be hand-listed here AND in deploy.sh, so a new module silently fell out of one of them).
MODS=$(grep -vE '^\s*(#|$)' inline-modules.txt | tr '\n' ' ')
BUILD=$(cat ui.html worker.src.js $MODS | shasum -a 256 | cut -c1-10)
B64=$(sed "s/__BUILD__/$BUILD/g" ui.html | base64 | tr -d '\n')
{ echo "const B64=\"$B64\"; const BUILD=\"$BUILD\";"; for m in $MODS; do sed 's/^export //' "$m"; done; cat worker.src.js; } > worker.js  # inlined modules are shared with the bridge/tests: plain declarations here
echo "built worker.js ($(wc -c < worker.js) bytes)"
