#!/bin/bash
set -e
cd "$(dirname "$0")"
BUILD=$(cat ui.html worker.src.js budget.mjs | shasum -a 256 | cut -c1-10)
B64=$(sed "s/__BUILD__/$BUILD/g" ui.html | base64 | tr -d '\n')
{ echo "const B64=\"$B64\"; const BUILD=\"$BUILD\";"; sed 's/^export //' budget.mjs; cat worker.src.js; } > worker.js  # budget.mjs is shared with the bridge: inlined here as plain declarations
echo "built worker.js ($(wc -c < worker.js) bytes)"
