#!/bin/bash
# Offline checks (no network): syntax of the Worker, bridge, hook, and the UI script. Used by CI.
set -e; cd "$(dirname "$0")"
# Exec-bit guard, FIRST so it can't be pre-empted by ./build.sh below dying at 126 with a raw "Permission denied".
# Rewriting a file with python3 + os.replace drops its executable bit; 89ac9f8 did exactly that to run-tests.sh, and
# the suite (including the nightly scheduled run) died with "Permission denied" until 2026-09-18. The target set is
# DERIVED, never hand-listed, so a new script is covered the day it lands: (A) every path the index records 100755,
# plus (B) every path invoked as ./x by a script, package.json, or CI, plus (C) every tracked file that is -x on
# disk -- (C) matters because demoting a file to 644 in the index would otherwise drop it out of (A) and go unseen.
# Each must be -x on disk, 100755 in the index,
# and start with a shebang that is not CRLF-terminated.
command -v git >/dev/null 2>&1 || { echo "jam: FAIL exec-bit guard needs git on PATH" >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "jam: FAIL exec-bit guard must run inside the git worktree" >&2; exit 1; }
EXEC_FILES=$(
  { git ls-files -s | awk -F'\t' '$1 ~ /^100755 /{print $2}'
    grep -hoE '\./[A-Za-z0-9_][A-Za-z0-9_.-]*\.(sh|mjs|cjs|js)' *.sh package.json .github/workflows/*.yml 2>/dev/null | sed 's|^\./||'
    # (C) is skipped on Windows: Git Bash reports every file as -x there, so it would flag every 100644 file with a shebang (e.g. auth.test.mjs).
    case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ;; *) git ls-files | while IFS= read -r t; do [ -f "$t" ] && [ -x "$t" ] && printf '%s\n' "$t"; done;; esac
  } | sort -u
)
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -e "$f" ] || continue
  [ -L "$f" ] && continue                        # tracked symlinks are 120000 by design, not a mode bug
  if [ ! -x "$f" ] && ! case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) true;; *) false;; esac; then
    echo "jam: FAIL $f is not executable - chmod +x $f (python3 os.replace drops the exec bit)" >&2; exit 1
  fi
  MODE=$(git ls-files -s -- ":(literal)$f" | awk 'NR==1{print $1}')
  if [ -z "$MODE" ]; then
    echo "jam: FAIL $f is run as ./$f but is not tracked - git add $f" >&2; exit 1
  fi
  if [ "$MODE" != "100755" ]; then
    echo "jam: FAIL $f is $MODE in git, not 100755 - git update-index --chmod=+x $f" >&2; exit 1
  fi
  if [ "$(head -c 2 -- "$f")" != "#!" ]; then
    echo "jam: FAIL $f is executable but has no #! line - it will run under the caller's shell, not its interpreter" >&2; exit 1
  fi
  case "$(head -1 -- "$f")" in *$'\r') echo "jam: FAIL $f has CRLF line endings - exec fails with 'bad interpreter'" >&2; exit 1;; esac
done <<EOF
$EXEC_FILES
EOF
node --check worker.src.js && node --check bridge.mjs && node --check approve-hook.mjs && node --check route.mjs && node --check catalog.mjs && node --check tune-router.mjs && node --check schedule.mjs && node --check browser.mjs && node --check budget.mjs && for m in turntext turn-events turn-policy models session-store compaction room-dispatch uploads schedule-cli sandbox worker-lib jam-url; do node --check "$m.mjs"; done
for f in scripts/stack.mjs scripts/dev.mjs dev/fake-claude.mjs test-stack.mjs; do node --check "$f"; done
node route.test.mjs
node catalog.test.mjs
node tune-router.test.mjs
node turntext.test.mjs
node schedule.test.mjs
node budget.test.mjs
# bridge.mjs was split into these modules on 2026-10-09 so the turn lifecycle can be tested without a live claude; each owns its tests.
for t in turn-events turn-policy models session-store compaction room-dispatch uploads schedule-cli; do node "$t.test.mjs"; done
node jam-url.test.mjs
# Scheme guard (2026-10-09): clients reach the hub through jam-url.mjs (httpBase/wsBase) so a loopback dev stack can speak plain http/ws. A literal
# `${host}`-style https:// or wss:// URL in a client puts the production-only assumption back and silently breaks `npm run e2e`.
if grep -nE '`(https|wss)://\$\{(host|H|env\.JAM_HOST)\}' bridge.mjs approve-hook.mjs browser.mjs test.mjs test-*.mjs *.test.mjs 2>/dev/null; then echo "jam: FAIL a client hard-codes https:// or wss:// for the hub; use httpBase()/wsBase() from jam-url.mjs" >&2; exit 1; fi
# ...and none of them may spawn: the spawn()/.on("error") guard below only reads bridge.mjs, so a spawn hiding in a helper module would escape it.
if grep -lE "node:child_process|child_process" turn-events.mjs turn-policy.mjs models.mjs session-store.mjs compaction.mjs room-dispatch.mjs uploads.mjs schedule-cli.mjs; then echo "jam: FAIL a bridge helper module imports child_process; keep every spawn() in bridge.mjs (its .on(\"error\") guard only reads that file)" >&2; exit 1; fi
# Driver-sandbox regression gate. This was a P0 ("a driver is effectively RCE today", sam-security 2026-09-15)
# fixed in classify()/RISKY_BASH on 2026-09-21 (commit 808405e) — but that fix was never wired into this CI
# gate, so it only ran when someone remembered to run it by hand, against a hand-copied duplicate of classify()
# that couldn't have caught the bridge.mjs PreToolUse matcher never being updated to list Read/Grep/Glob/
# WebFetch (dead code: classify() gates those tools, but Claude Code never invokes the hook for them). Both are
# fixed as of this commit; this line is what makes it a permanent gate instead of a one-time manual check.
node test-sandbox.mjs
node test-sandbox-exec.mjs
node test-runlocal.mjs
node test-harmful.mjs
node test-bridge-turn.mjs   # offline end-to-end: fake TLS hub + stub claude drive the real bridge.mjs through turns, retries, caps, uploads, /compact (skips on Windows or without openssl)
node test-single-bridge.mjs   # offline: throwaway HOME + unroutable host; the newest full-scope bridge must stop the older one
# Driver-env guard (2026-10-09 review): a driver turn's claude must never inherit JAM_KEY when .jam-key exists on disk (the hook reads the key from there).
grep -qF 'item.role === "driver" && existsSync(path.join(here, ".jam-key"))) delete env.JAM_KEY' bridge.mjs || { echo "jam: FAIL bridge.mjs no longer deletes JAM_KEY from the driver turn env (key leak off-macOS / with JAM_DRIVER_SANDBOX=off)" >&2; exit 1; }
node -e "new Function(require('fs').readFileSync('ui.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"
./build.sh >/dev/null && node --check worker.js
# worker.js is a committed build artifact. In CI (clean checkout) a rebuild that differs from what was committed means someone edited ui.html,
# worker.src.js, budget.mjs, worker-lib.mjs or inline-modules.txt and forgot to commit the regenerated bundle. Locally the tree is usually dirty, so only CI enforces it.
if [ -n "${CI:-}" ] && ! git diff --quiet -- worker.js; then echo "jam: FAIL worker.js is stale: run ./build.sh and commit the regenerated worker.js" >&2; git diff --stat -- worker.js >&2; exit 1; fi
node worker-lib.test.mjs
node test-worker-hub.mjs | tail -3   # offline: imports the BUILT worker.js and drives Hub REST + auth routing with a fake Durable Object runtime
# Self-update regression guard: build.sh's sed substitutes every literal occurrence of __BUILD__, so any client-
# side check written as `BUILD!=="__BUILD__"` becomes `<hash>!=="<hash>"` after a build — always false, dead code
# that silently disables the tab auto-reload path (shipped broken since e3b033b, found 2026-09-10). Fail loud if
# that pattern ever comes back.
HASH=$(grep -o 'const BUILD="[a-z0-9]*"' worker.js | head -1 | grep -o '"[a-z0-9]*"' | tr -d '"')
if [ -n "$HASH" ] && grep -q "!==\"$HASH\"" worker.js; then
  echo "jam: FAIL self-update guard compares BUILD against its own hash ($HASH) — dead code, tabs will never reload" >&2
  exit 1
fi
# Co-browsing regression guards. (1) The click handler once spawned browser.mjs with --silent, which skips the
# screenshot + card entirely, so clicks ran but nothing posted (dead from ba68841 until 7db8c78). (2) Viewers must
# not be able to fire clicks from the screenshot. Both were invisible to every other test.
node -e '
const fs=require("fs");const b=fs.readFileSync("bridge.mjs","utf8");const u=fs.readFileSync("ui.html","utf8");
const m=/function handleBrowserClick\([\s\S]*?\n\}\n/.exec(b);
if(!m){console.error("jam: FAIL handleBrowserClick not found in bridge.mjs");process.exit(1)}
if(m[0].includes("--silent")){console.error("jam: FAIL handleBrowserClick passes --silent: clicks would post no card");process.exit(1)}
if(!/addEventListener\("click",function\(ev\)\{\s*if\(!canDrive\)return;/.test(u)){console.error("jam: FAIL screenshot click handler lost its canDrive guard: viewers could drive the browser");process.exit(1)}'
# Spawn-safety regression guard: an unlistened 'error' event on ANY spawn() throws and kills the whole bridge, every
# room at once — that's what happened 2026-09-28 (claudeBin briefly missing mid self-update) and is exactly the
# class of bug a future spawn() call site can silently reintroduce. Every real spawn( call must have a matching
# .on("error" on the SAME variable it assigns, searched across that spawn's own enclosing top-level function (brace-
# matched from the nearest preceding `function`/`async function`) rather than a fixed line window or "until the next
# spawn(" — both false-failed here: the turn runner's handler lands ~150 lines after its spawn(), well past the
# unrelated caffeinate spawn() in between, and a fixed window missed the login/browser-click sites entirely the
# first time this guard was written. Commented-out mentions of spawn( don'"'"'t count and must not inflate the count.
node -e '
const fs=require("fs");const src=fs.readFileSync("bridge.mjs","utf8");const lines=src.split("\n");
function enclosingFunctionBody(lineIdx){ // lineIdx: 0-based line of the spawn( call
  let start=-1;
  for(let i=lineIdx;i>=0;i--){ if(/^(async\s+)?function\b/.test(lines[i])){start=i;break;} }
  if(start===-1) return null;
  let depth=0, seenOpen=false, end=lines.length-1;
  for(let i=start;i<lines.length;i++){
    for(const ch of lines[i]){ if(ch==="{"){depth++;seenOpen=true;} else if(ch==="}"){depth--;} }
    if(seenOpen && depth<=0){end=i;break;}
  }
  return lines.slice(start,end+1).join("\n");
}
const sites=[]; // {line, varName}
lines.forEach((line,i)=>{
  const idx=line.indexOf("spawn(");
  if(idx===-1)return;
  if(line.slice(0,idx).includes("//"))return; // spawn( mentioned only in a comment on this line
  const before=line.slice(0,idx);
  // Prefer the declared local (`const ch = r.child = spawn(...)` attaches .on("error") to `ch`, not `r.child`);
  // only a bare re-assignment with no declaration (`r.caffeinate = spawn(...)`) falls back to that target itself.
  const declMatch=/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(before);
  const varName = declMatch ? declMatch[1] : ((/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*=\s*$/.exec(before.trimEnd()))||[])[1] || null;
  sites.push({line:i+1, varName});
});
if(sites.length<5){console.error(`jam: FAIL expected at least 5 real spawn() call sites in bridge.mjs, found ${sites.length} - a spawn call may have gone missing`);process.exit(1)}
const missing=[];
sites.forEach(s=>{
  if(!s.varName){missing.push(`${s.line} (could not determine its variable name)`);return;}
  const body=enclosingFunctionBody(s.line-1);
  if(!body){missing.push(`${s.line} (no enclosing function found - guard needs updating)`);return;}
  // Strip line comments before matching (a commented-out handler must not count as present - a real risk: someone
  // disables one to debug and forgets to put it back) and require a non-identifier character (or start of line)
  // right before the variable name, so a search for "ch" can'"'"'t be satisfied by "each.on(\"error\"".
  const codeOnly=body.split("\n").map(l=>{const c=l.indexOf("//");return c===-1?l:l.slice(0,c);}).join("\n");
  const v=s.varName.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const re=new RegExp("(^|[^\\w$.])"+v+"\\.on\\(\\s*[\"\\x27]error[\"\\x27]");
  if(!re.test(codeOnly)) missing.push(`${s.line} (${s.varName})`);
});
if(missing.length){console.error(`jam: FAIL spawn() with no matching .on("error") handler on its own variable at bridge.mjs line(s): ${missing.join(", ")} - an unhandled error event there crashes the WHOLE bridge`);process.exit(1)}
console.log(`jam: spawn-safety guard ok (${sites.length} spawn() call sites, all handled)`)'
# onmessage-handler regression guard: a thrown error anywhere in either the hub socket's or a room socket's
# onmessage propagates through WebSocket's dispatchEvent and kills the WHOLE bridge, every room at once (2026-09-28
# outage: a room.change broadcast with no `room` field read `.name` off undefined in the hub one; the room one was
# found 2026-09-29, writing this guard, to have the exact same unguarded JSON.parse and no try/catch at all — a
# fixed-position regex checking only "the first ws.onmessage" would have kept missing it). Every `ws.onmessage = ev
# => {` in the file must have its OWN body wrapped in one try/catch. Naive char-by-char brace-counting was tried
# first and is WRONG here: the file is full of template literals and comments containing stray `{`/`}` (e.g.
# `${cfg.name}`) that miscount and let the scan run past the real closing brace into unrelated code — proven by a
# negative test where it kept reporting a handler with its try/catch physically deleted as still wrapped. Instead,
# match this handler'"'"'s own closing brace by the SAME leading indentation as its opening line, which is how this
# file is actually formatted (checked against source, not assumed).
node -e '
const fs=require("fs");const src=fs.readFileSync("bridge.mjs","utf8");const lines=src.split("\n");
function innerLines(startLineIdx){ // 0-based line index of "ws.onmessage = ev => {"; returns the lines strictly between it and its own matching "};"
  const indent=(/^\s*/.exec(lines[startLineIdx]))[0];
  const closeRe=new RegExp("^"+indent+"\\};\\s*$");
  for(let i=startLineIdx+1;i<lines.length;i++) if(closeRe.test(lines[i])) return lines.slice(startLineIdx+1,i);
  return null;
}
const re=/ws\.onmessage\s*=\s*ev\s*=>\s*\{/g; let m2, found=0; const bad=[];
while((m2=re.exec(src))){
  found++;
  const line=src.slice(0,m2.index).split("\n").length;
  const inner=innerLines(line-1);
  if(inner===null){bad.push(`${line} (could not find its own closing brace)`);continue;}
  // The whole body must be wrapped: skip leading blank/comment-only lines to find the first REAL statement (must
  // open with try {), and the closing catch must be the last real line (immediately before the handler'"'"'s own
  // closing brace) — an inner, narrowly-scoped try/catch used for one branch (there is a real one further down,
  // around appendFileSync for the router self-tuner) must not satisfy this by just existing somewhere in the body.
  const real=inner.filter(l=>l.trim()!=="" && !/^\s*\/\//.test(l));
  const first=real[0]||"", last=real[real.length-1]||"";
  if(!/^\s*try\s*\{/.test(first)) bad.push(`${line} (first statement is not "try {": ${JSON.stringify(first.trim().slice(0,60))})`);
  else if(!/^\s*\}\s*catch\b/.test(last)) bad.push(`${line} (last statement is not a closing "} catch": ${JSON.stringify(last.trim().slice(0,60))})`);
}
if(found<2){console.error(`jam: FAIL expected at least 2 ws.onmessage handlers (hub + room) in bridge.mjs, found ${found}`);process.exit(1)}
if(bad.length){console.error(`jam: FAIL ws.onmessage handler(s) at bridge.mjs line(s) ${bad.join("; ")} - a malformed frame there would crash the WHOLE bridge`);process.exit(1)}
console.log(`jam: onmessage-safety guard ok (${found} handlers, all wrapped)`)'
# Self-restart watch-list guard (2026-10-09 review): bridge.mjs restarts itself when a file it imports changes on disk, but the list of watched
# files is hand-written. turntext.mjs was never on it, so edits to it shipped without a restart. Every local import must be watched.
node -e '
const src=require("fs").readFileSync("bridge.mjs","utf8");
const imports=[...src.matchAll(/^import\s[^;]*?from\s+"\.\/([\w.-]+\.mjs)";/gm)].map(m=>m[1]);
const watch=(/const files = \[([^\]]*(?:\][^\]]*)*?)\]; \/\/ static imports/.exec(src)||[])[1]||"";
const missing=imports.filter(f=>!watch.includes("\""+f+"\""));
if(!imports.length||!watch){console.error("jam: FAIL could not find bridge.mjs imports or its self-restart watch list");process.exit(1)}
if(missing.length){console.error("jam: FAIL bridge.mjs imports "+missing.join(", ")+" but does not watch it for self-restart (add it to the files list near the end of bridge.mjs)");process.exit(1)}
console.log("jam: self-restart watch list ok ("+imports.length+" imports)")'
echo "jam: all checks passed"
