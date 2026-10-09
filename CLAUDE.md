# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

jam runs shared, multi-user Claude Code sessions. Each **room** is one `claude -p --resume` session in one directory on a host machine. Browsers join via short invite links and share a live transcript. Roles are owner (unrestricted), driver (talks to Claude, risky tool calls need owner approval) and viewer. README.md covers features and setup; SCHEDULER.md covers scheduled turns.

## Commands

```sh
./check.sh                 # offline CI gate: exec-bit guard, node --check, unit tests, sandbox/hook tests, build, regression guards
node route.test.mjs        # run one unit test (also catalog, tune-router, turntext, schedule, budget .test.mjs)
node test-sandbox.mjs      # approval-hook / driver-sandbox gates (also test-sandbox-exec, test-runlocal, test-harmful .mjs)
./build.sh                 # regenerate worker.js from ui.html + budget.mjs + worker.src.js
./run-tests.sh             # end-to-end suite against the LIVE deployed Worker (needs .jam-key, JAM_HOST; Playwright via `npm i`)
./run.sh                   # start the host bridge (supervises bridge.mjs, restarts it on exit)
./deploy.sh                # build + bundle gate + deploy to Cloudflare + verify build hash; `./deploy.sh --check` = gate only
npx markdownlint-cli2 "**/*.md" "#node_modules"   # Markdown lint (config: .markdownlint.jsonc)
actionlint                 # workflow lint; or: docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest -color
```

- CI (`.github/workflows/ci.yml`) has two jobs, both required on `main`: `check` (`npm ci && ./check.sh` on Node 22; the bridge needs the global `WebSocket`, which Node 18 and 20 lack) and `lint` (markdownlint-cli2 over all Markdown, plus actionlint).
- `check.sh` is the whole offline gate: the unit tests, the sandbox/hook tests, and `test-bridge-turn.mjs` (a fake TLS hub plus a stub `claude` drive the real `bridge.mjs` through turns, retries, usage caps, uploads and `/compact`; it skips on Windows or without `openssl`). The `auth`, `compact`, `switch`, `reconnect` and `runlocal` `.test.mjs` files and `test.mjs`/`test-upload`/`test-cobrowse`/`test-boot`/`test-status-bar` are *not* offline: they talk to the live Worker and run only via `run-tests.sh`.
- `check.sh` assumes macOS/Linux. Under Windows Git Bash, the exec-bit guard false-fails on any shebang file stored as `100644` (e.g. `auth.test.mjs`), and several hook/sandbox tests fail on Windows paths. Use WSL, or run the pure unit tests individually.
- Unit tests are plain Node scripts with no test framework; each prints a pass/fail summary and exits non-zero on failure.
- `run-tests.sh` creates and deletes `test-*` rooms on the real Worker; normal bridges ignore `test-*` rooms. If you are running *inside* a jam room, the inherited `JAM_*` env points test bridges at the live room. Strip it first, as `nightly.sh` does: `env -u JAM_HOST -u JAM_KEY -u JAM_ROOM -u JAM_FROM -u JAM_FROM_ROLE -u JAM_TURN -u JAM_CWD ./run-tests.sh`.
- `deploy.sh` and `deploy-idle.sh` ship to production. A deploy recycles the Durable Objects and drops every socket, which is why `deploy-idle.sh` waits until no jam turn is running.

## Architecture

```text
browser ─wss─▶ Cloudflare Worker (worker.js) ◀─wss─ bridge.mjs on the host ─spawns─▶ claude -p (one per room)
                 Hub DO: rooms, invites, bridge+lobby sockets          │ PreToolUse hook ─▶ approve-hook.mjs
                 Room DO: transcript, sockets, approvals, queue        └ driver Bash ─▶ sandbox/bashwrap.sh (Seatbelt)
```

- **Worker** (`worker.src.js`): stateless fetch handler plus two Durable Objects. `Hub` is a singleton: room registry, invite tokens, the bridge socket (`/hub?role=bridge`), owner lobby sockets and budgets. `Room` is one per room: the transcript (last 5,000 entries), browser and bridge sockets, typing/presence, the message queue/outbox and approval cards. It also serves the single-page UI for `/`, `/r/<room>` and `/j/<token>`, and `/health` reports the build hash.
- **UI** (`ui.html`) is one self-contained file. `build.sh` base64-embeds it into `worker.js`, and `budget.mjs` is inlined with `export` stripped. So `budget.mjs` must stay free of imports and work both as an ES module (bridge) and as plain declarations (Worker).
- **Bridge** (`bridge.mjs`) runs on the host. It connects to the Hub, opens a socket per room, and runs each queued message as `claude -p --output-format stream-json --dangerously-skip-permissions --settings ~/.jam/settings.json --setting-sources user` (session id per room). It then streams events back to the room. It also handles model routing, automatic compaction (writes a handoff, starts a fresh session seeded with it), usage-cap fallback, the scheduler tick, uploads, co-browsing clicks, and host auth/plan polling. Since 2026-10-09 the pure and stateful pieces live in sibling modules (below); `bridge.mjs` keeps the process wiring, every `spawn()` and both `ws.onmessage` handlers.
- **Approval gate** (`approve-hook.mjs`) is a Claude Code PreToolUse hook (matcher `.*`) that the bridge writes into `~/.jam/settings.json`. Owners pass. For drivers, calls that match `CONTROL_BASH`/`RISKY_BASH`, plus file tools reaching outside the room or into sensitive paths, are posted to the room as Allow/Deny cards. Exit 0 = allow, exit 2 = block, and it fails closed.
- **Driver sandbox** (`sandbox.mjs`, `sandbox/driver.sb`, `sandbox/bashwrap.sh`): on macOS, a driver turn's Bash commands run under a Seatbelt profile via `CLAUDE_CODE_SHELL_PREFIX`. Writes are limited to the room dir and a per-turn scratch dir, and credential-shaped env is scrubbed. `claude` itself is not wrapped. Other platforms have no sandbox, and `JAM_DRIVER_SANDBOX=off` disables it.
- **Pure, offline-testable modules** (each has a `*.test.mjs` sibling run by `check.sh`): `route.mjs` (auto-router: message → light/medium/heavy tier and model, plus the context-window guard), `tune-router.mjs` (self-tunes router thresholds from logged misses), `schedule.mjs` (5-field UTC cron with 24h catch-up), `budget.mjs` (per-driver share of the host's Claude plan), `catalog.mjs` (Models API + pricing → model catalog), `turntext.mjs`.
- **Bridge modules** (each has a `*.test.mjs` sibling run by `check.sh`; none may import `child_process`, which `check.sh` enforces): `turn-events.mjs` (stream-json → room events reducer, tool labels, cost estimate), `turn-policy.mjs` (ordered retry/outcome decisions for a finished or crashed turn; the order of its guards is the contract), `models.mjs` (capped models, real context windows, fallback tier), `session-store.mjs` (sessions, queues, user colors under an injected `~/.jam`), `compaction.mjs` (thresholds, handoff prompts, attempt order, transcript tail), `room-dispatch.mjs` (glob/room-open rules, say dedupe, `/compact` and router-miss detection), `uploads.mjs` (chunk assembly and its size bounds), `schedule-cli.mjs`. A new module `bridge.mjs` imports must also be added to the self-restart watch list near the end of `bridge.mjs`, or edits to it won't trigger a restart.
- **Ops scripts** (macOS launchd): `setup.sh` (first-run key + deploy), `watchdog.sh` (restarts a dead or hub-disconnected bridge; `--check` is a dry run, always use it to test changes), `nightly.sh` (single verdict for `check.sh` + `run-tests.sh`, flags exit 126/127 as "never ran"), and the `io.nullagency.jam*.plist` job definitions.
- **Host state** lives in `~/.jam/`: `sessions/<room>.json` and compaction handoffs, `queue-<room>.json` (replayed after restart), `settings.json`, `scheduled.json`, `uploads/<room>/`, `routing.jsonl`, `compactions.jsonl` and `router-weights.json`. Deleting a room's session file starts it fresh.

## Rules that `check.sh` enforces (and why)

- **`worker.js` is a committed build artifact.** Edit `worker.src.js`, `ui.html` or `budget.mjs`, run `./build.sh`, and commit the regenerated `worker.js` with them. `build.sh` replaces every literal `__BUILD__`, so never compare `BUILD` against the string `"__BUILD__"` (that silently disables tab auto-reload).
- **Every `spawn()` in `bridge.mjs`** needs a `.on("error")` on the same variable inside its enclosing function. An unhandled spawn error kills the whole bridge and every room.
- **Every `ws.onmessage = ev => {` handler in `bridge.mjs`** must have its entire body in one `try { … } catch`, with the closing `};` at the same indentation as the opening line (the guard matches on indentation).
- **Executable scripts** must be `100755` in git, start with `#!` and use LF line endings. On Windows, set the bit with `git update-index --chmod=+x <file>`.
- `handleBrowserClick` must not pass `--silent` to `browser.mjs`, and the screenshot click handler in `ui.html` must keep its `if(!canDrive)return;` guard.

## Security invariants

The bridge runs Claude with permissions skipped, so these are what stand between a driver and the owner's machine. Keep them intact when changing turn spawning:

- Driver turns load only user settings (`--setting-sources user`). A room's own `.claude/settings.json` or `.mcp.json` could otherwise run hooks with owner rights.
- No long-lived process holds `JAM_KEY` in its environment, because same-uid processes can read env via sysctl. `run.sh` exports only `JAM_*` keys from `.env` and never `JAM_KEY`, and the bridge and hook read `.jam-key` from disk.
- New risky command shapes go in `approve-hook.mjs` with a case in `test-sandbox.mjs` or `test-harmful.mjs`.

## Style

Code is dense, with long lines and few blank lines. Comments explain *why*, often citing the dated incident that motivated a guard (e.g. "2026-09-28 outage"). Match that, and keep the existing regression comments when editing nearby code.

- `.editorconfig` sets UTF-8, 2-space indent and a final newline. `.gitattributes` forces LF everywhere except `*.cmd`/`*.bat` (CRLF, e.g. `run.cmd`).
- Workflow actions are pinned to a full commit SHA (or image digest) with the version in a trailing comment, e.g. `uses: actions/checkout@<sha> # v7.0.1`. Dependabot bumps actions and npm weekly in grouped PRs. Workflows use `permissions: contents: read` and `persist-credentials: false`.

## Pull requests

See CONTRIBUTING.md. In short: branch from `main`, one focused change per PR, and fill in the PR template. PRs are squash-merged, so the PR title becomes the commit message. Merging needs an approving review from `@jaypetez` (CODEOWNERS), and pushing after approval dismisses it.
