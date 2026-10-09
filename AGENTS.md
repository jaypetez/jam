# AGENTS.md

Instructions for AI coding agents (and humans in a hurry) working in this repository. [CLAUDE.md](CLAUDE.md) holds the architecture and the
security invariants; this file is the operating contract: how to verify a change, what you must not touch, and where things live.

jam runs shared, multi-user Claude Code sessions: a Cloudflare Worker (rooms, transcript, invites) plus a bridge on a host machine that runs
one `claude -p --resume` per room. The bridge runs Claude with permissions skipped, so changes near the approval hook, the sandbox or turn
spawning are security-sensitive.

## Verify a change

```sh
npm ci && npm run setup:e2e     # once per machine: dependencies, and the Chromium build your Playwright version needs
npm test                        # = ./check.sh, the fast offline gate (about a minute). Last line "jam: all checks passed" means green.
npm run verify                  # = npm test + npm run test:stack + npm run e2e: everything, on a real local stack (about 5 minutes)
```

`npm run verify` is the command that proves a change works: it starts the **real Worker on workerd** (real Durable Objects), a **real bridge**, a
deterministic **fake claude** and **real headless Chromium**, all in a throwaway directory, and runs the live end-to-end suite against them. It
needs no credentials, no quota and no network beyond `npm`, and cannot touch production. [docs/DEV.md](docs/DEV.md) explains the loop. Run
`npm run dev` for an interactive stack (owner, driver and viewer links) to poke at a change by hand.

`npm test` needs `bash`, Node 22+, `git`, and the usual `shasum`, `base64`, `sed`, `awk`, `grep`, plus `ps` (`procps`) for the single-bridge test.
`openssl` is optional: the end-to-end bridge test makes a throwaway certificate with it and skips without it. It is offline: no network, no credentials, no Cloudflare. It stops at the first failure (`set -e`).

On **macOS or Linux** run it directly. On **Windows** the exec-bit and path assumptions are partly wrong under Git Bash; use WSL or a
container. This runs the committed state of your branch on Linux, exactly like CI:

```sh
docker run --rm -v "$PWD:/repo:ro" node:22-bookworm-slim bash -c 'apt-get update -qq && apt-get install -y -qq git procps openssl >/dev/null && git config --global --add safe.directory "*" && git clone -q /repo /w && cd /w && npm ci && CI=true ./check.sh'
```

Commit first (it clones). `CI=true` also turns on the stale-`worker.js` guard.

Markdown and workflows are linted separately in CI:

```sh
npx markdownlint-cli2 "**/*.md" "#node_modules"
actionlint
```

## What is tested, and how to run one

Every test is a plain Node script: no framework, prints PASS/FAIL lines, exits non-zero on failure. Run any one with `node <file>`.

| Area | Files | Notes |
| --- | --- | --- |
| Router, catalog, schedules, budgets, turn text | `route`, `catalog`, `tune-router`, `schedule`, `budget`, `turntext` `.test.mjs` | pure |
| Bridge turn pipeline | `turn-events`, `turn-policy`, `models`, `session-store`, `compaction`, `room-dispatch`, `uploads`, `schedule-cli` `.test.mjs` | pure or temp-dir only |
| Whole bridge, offline | `test-bridge-turn.mjs` | fake TLS hub plus `dev/fake-claude.mjs`; POSIX and `openssl` only |
| Bridge singleton lock | `test-single-bridge.mjs` | throwaway `HOME`; POSIX only |
| Worker helpers | `worker-lib.test.mjs` | pure |
| Worker Hub REST and auth | `test-worker-hub.mjs` | imports the **built** `worker.js` with a fake Durable Object runtime; run `./build.sh` first |
| Scheme selection, fake claude | `jam-url.test.mjs`, `fake-claude.test.mjs` | pure; the fake claude's rules and CLI |
| Real Worker + real bridge | `test-stack.mjs` (`npm run test:stack`) | wrangler and workerd; about 5 s; checks teardown leaves nothing behind |
| The live suite, locally | `npm run e2e`: `test.mjs`, `test-upload`, `compact`, `test-status-bar`, `reconnect`, `test-statusbar-live`, `test-boot`, `test-cobrowse`, `auth`, `switch` | local stack, fake claude; browser tests need `npm run setup:e2e`; `--only <name>` runs one |
| Approval hook and driver sandbox | `test-sandbox.mjs`, `test-harmful.mjs`, `test-runlocal.mjs`, `test-sandbox-exec.mjs` | the last needs macOS Seatbelt and skips elsewhere |

`run-tests.sh` runs those same live test files against a **deployed** Worker. **Do not run it** unless the maintainer has asked you to and given
you the host and key: it creates and deletes `test-*` rooms on production, and from inside a jam room the inherited `JAM_*` environment points its
bridges at the live room. `npm run e2e` is the safe way to run them.

Not covered by any local test, so say so in the PR rather than implying it was tested:

- **`runlocal.test.mjs` and `test-sandbox-exec.mjs` need macOS.** Card-free driver commands exist only under the Seatbelt sandbox, so `npm run e2e`
  reports that stage SKIPPED (never passed) on Windows and Linux.
- **Real Claude behaviour.** The fake claude is a model of the CLI. `npm run e2e:real` runs the suite against your own `claude` (spends quota).
- **Deployment**: `deploy.sh`, Cloudflare account behaviour, real DNS and TLS.

## Hard rules

- **Never run `deploy.sh`, `deploy-idle.sh` or `run-tests.sh`.** (`npm run dev`, `npm run e2e` and `npm run verify` are safe: they start a private stack on 127.0.0.1.) A deploy recycles every Durable Object and drops every socket. `./deploy.sh --check` (build plus bundle gate, no upload) is safe, but it creates an untracked `.jam-key` if none exists; delete that file if you did not already have one.
- **Never commit** `.jam-key`, `.env*` (except `.env.example`), `~/.jam` contents or logs. Never put the owner key in a URL you paste anywhere.
- **`worker.js` is generated.** Edit `worker.src.js`, `ui.html`, `budget.mjs`, `worker-lib.mjs` or `inline-modules.txt`, run `./build.sh`, commit the regenerated `worker.js`. CI fails on a stale bundle.
- **Spawns stay in `bridge.mjs`.** Every `spawn()` needs an `.on("error")` on the same variable in the same function, and both `ws.onmessage` handlers must wrap their whole body in one `try { } catch`. The helper modules must not import `child_process`. `check.sh` enforces all three.
- **Inlined modules** (`budget.mjs`, `worker-lib.mjs`) must have no imports and start every top-level declaration with the word `export` followed by a space, so `build.sh` can strip it.
- **A new module the bridge imports** must be added to the self-restart watch list near the end of `bridge.mjs` (enforced), and gets a `*.test.mjs` sibling run by `check.sh`.
- **New risky command shapes** go in `approve-hook.mjs` with a case in `test-sandbox.mjs` or `test-harmful.mjs`.
- Driver turns load only user settings (`--setting-sources user`), and no long-lived process may hold `JAM_KEY` in its environment. See the security invariants in CLAUDE.md before touching turn spawning.
- Shebang scripts must be mode `100755` in git (`git update-index --chmod=+x <file>`) with LF endings.

## Where things live

| Path | Role |
| --- | --- |
| `bridge.mjs` | Host process wiring: hub and room sockets, turn spawn, watchdog, auth login. Keep it thin. |
| `turn-events.mjs`, `turn-policy.mjs` | stream-json to room events; the ordered retry and outcome guards (the order is the contract) |
| `models.mjs`, `compaction.mjs`, `session-store.mjs` | capped models and windows; compaction thresholds and prompts; sessions, queues, colors under an injected `~/.jam` |
| `room-dispatch.mjs`, `uploads.mjs`, `schedule-cli.mjs` | room-open rules and dedupe; chunked uploads and their bounds; the schedule CLI |
| `approve-hook.mjs`, `sandbox.mjs`, `sandbox/` | the approval gate and the macOS driver sandbox |
| `route.mjs`, `tune-router.mjs`, `catalog.mjs`, `schedule.mjs`, `budget.mjs` | auto-router and its self-tuning, model catalog, cron, per-driver budgets |
| `worker.src.js`, `worker-lib.mjs`, `ui.html` | the Worker (Hub and Room DOs), its pure helpers, the single-file UI |
| `docs/PROTOCOL.md` | the wire protocol; update it in the same PR as any message change |
| `check.sh`, `build.sh`, `inline-modules.txt` | the gate, the bundler, the list of inlined modules |
| `jam-url.mjs` | http/ws for a loopback host, https/wss otherwise (`JAM_SCHEME` overrides). Clients never hard-code a scheme (`check.sh` enforces it). `approve-hook.mjs` inlines its own copy on purpose. |
| `scripts/stack.mjs`, `scripts/dev.mjs`, `scripts/e2e.mjs` | the local stack, `npm run dev`, and the end-to-end orchestrator |
| `dev/fake-claude.mjs`, `dev/fake-claude-rules.mjs` | the deterministic fake `claude`: protocol and files, and the pure rules table (add a rule there when a test needs a new answer) |

## Making a change

1. Branch from `main`; one focused change per PR.
2. Write or extend a test first when behaviour changes. Prefer the pure modules: a bug in turn handling is a case in `turn-policy.test.mjs`, a protocol bug in `test-worker-hub.mjs`, a whole-bridge behaviour in `test-bridge-turn.mjs`, anything that crosses the Worker's websockets or the browser in `test-stack.mjs` or one of the live test files (they now run locally).
3. Match the surrounding style: dense lines, comments that explain *why* and cite the dated incident that motivated a guard. Keep existing regression comments.
4. `npm run verify` (or at least `npm test`), then the Markdown lint if you touched docs. CI runs `check`, `lint` and `e2e`.
5. Open a PR using the template. PRs are squash-merged and need the maintainer's approval; do not merge, and do not use `--admin`, unless the maintainer told you to.
