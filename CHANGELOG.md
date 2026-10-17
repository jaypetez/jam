# Changelog

All notable changes to jam are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/). Releases are tagged `vX.Y.Z` on `main`; a release does not deploy anything, so a running
Worker only changes when its owner runs `./deploy.sh`.

## [Unreleased]

Synced from the Null Agency deployment (jam.nullagency.io), 2026-10-09 to 2026-10-16.

### Added

- **Hosts.** Other people run rooms on their own Claude against a hosted hub: the root owner mints a one-time host code in the lobby's Hosts
  panel; `curl /dl/jam.tgz | tar xz && node claim.mjs <code> <name> && ./run.sh` sets a machine up (the key never leaves it). Each host gets its own
  Hub and Rooms (`t:<host>`, derived only in `hubId`/`roomId`/`registryId`; check.sh gates it), a 20-room cap, disable (kicks every socket) and
  delete. A host's guests must run on `JAM_DRIVER_API_KEY` (Anthropic's consumer terms don't allow sharing a subscription). New `Registry` DO.
- **Marathon mode** (`marathon.mjs`). Owner turns are no longer killed at 10 minutes: they're cut at 10 min of silence or a 45-min checkpoint
  and continue from the session. A turn that ends with `MARATHON-CONTINUE <nonce>` continues (12 unattended turns max, reset when an owner
  posts); `/marathon on` keeps going until `MARATHON-DONE`; `/marathon off` restores the 10-minute kill. Pauses at 2% plan left, resumes at 10%
  (checked every 15 min). Guests are never continued. Owner switch in the Turn panel.
- **Invite roles editable in place**: the role badge on each invite row is a dropdown for the host owner. Tabs reload with the new role; a
  demotion or revoke re-roles or drops that person's queued, paused and running work (`demote`).
- Owner slash commands run for real (`/name …` goes to Claude Code raw), with autocomplete in the composer. Terminal-only commands run in a
  throwaway pty (`termcmd.py`) when "Run commands on this machine" is on.
- A copy button under every message (fenced code copies only the code).
- `~` and `~/path` are accepted as a room directory (the bridge expands them against the host's home).

### Changed

- The bridge's self-restart watch list is derived from its own import lines (marathon.mjs was missed by the hand-written one); check.sh
  verifies the derivation instead of the list.
- A killed first turn that already wrote a transcript resumes it next turn instead of abandoning the session (`decideNoResult` gets `resumable`).
- Sockets that never open back off 3 s → 60 s instead of retrying every 3 s.

### Fixed

- **Room state survived no Durable Object eviction**: an inline `//` comment in `Room.load()` swallowed the restore of schedules, usage, auth,
  catalog, ctx and session, and the next save made the loss permanent (all six are bridge mirrors, re-sent on reconnect). `saveMeta()` and
  `load()` now walk one list (`ROOM_MIRRORS`), and `room-meta.test.mjs` round-trips every field through a fresh Room.
- A hung compaction in a marathon room was never killed (the marathon watchdog skips compactions); it gets the classic 10-minute kill again.
- check.sh hid a crashing `test-worker-hub.mjs` behind `| tail` (its fake Hub now has `state.id` and a `REGISTRY` stub); `pipefail` is on for
  the test section. The termcmd steps are skipped on Windows Git Bash.
- `deploy.sh` verifies the bridge bundle hash (`/health` `bridge`) as well as `build`, so a bridge-only change can't pass unpropagated.
- check.sh parses under macOS's stock bash 3.2 (a `case` inside `$( )` needs `(pattern)`); test-sandbox-exec's spawn check matches `claudeCmd`.

### Upgrading

- The `Registry` Durable Object is new. Wrangler deploys pick up the `v2` migration from `wrangler.toml`; an existing install deploying through
  the API path (`deploy.sh` without wrangler) must pass it once:
  `JAM_MIGRATION='{"old_tag":"v1","new_tag":"v2","new_sqlite_classes":["Registry"]}' ./deploy.sh`.

## [0.4.1] - 2026-10-15

### Changed

- Dependency updates from Dependabot: `playwright` 1.63 to 1.64 (npm, used by the bridge's browser helper), and the `actions/checkout` and `actions/setup-node` pins in `deploy.yml` moved to their current releases.

## [0.4.0] - 2026-10-09

### Added

- **A self-contained dev loop.** `npm run dev` starts the real Worker on workerd (real Durable Objects), a real bridge and a deterministic fake `claude`
  in a throwaway directory and prints owner, driver and viewer links. `npm run e2e` runs the live end-to-end suite (previously production-only) against
  it, including the Playwright tests; `npm run test:stack` checks the Room and Hub Durable Objects over real websockets; `npm run verify` runs the lot.
  CI gains an `e2e` job. See `docs/DEV.md`.
- `jam-url.mjs` / `JAM_SCHEME`: clients speak http/ws to a loopback host and https/wss to everything else, instead of hard-coding TLS.
- `dev/fake-claude.mjs` and its rules table: writes Claude Code's session transcript, calls the real approval hook, simulates a few harmless shell
  builtins and never runs arbitrary commands.

### Changed

- `bridge.mjs`: `JAM_CLAUDE` may name a `.js/.mjs/.cjs` script, run with the bridge's own node (no shebang, exec bit or Windows shim needed).
- `deploy.yml` uses Node 22 (the bridge needs the global `WebSocket`).
- `wrangler` is now a dev dependency (it bundles workerd); only the local loop uses it. Nothing deploys from `npm run dev` or `npm run e2e`.
- A GitHub Actions `deploy.yml` (from PR #2) deploys on push to `main` behind a `production` environment approval. It cannot deploy until that environment and its secrets exist, and it does not yet wait for running turns to go idle.

### Fixed

- `test-boot.mjs` built a websocket URL inside a browser callback where its helper does not exist; found by the first local run of the suite.

## [0.3.0] - 2026-10-09

### Added

- `AGENTS.md`: the operating contract for AI coding agents (one verification command, what is and isn't offline, hard rules, code map).
- `docs/PROTOCOL.md`: the wire protocol between browsers, the Worker and the bridge, written from the code.
- `docs/hero.svg` and a restructured README with a quick start.
- Offline end-to-end tests: `test-bridge-turn.mjs` runs the real bridge against a fake TLS hub and a stub `claude` (normal turn, resume, replayed
  message, crash retry, usage-cap fallback, owner vs driver environment, uploads, `/compact`); `test-worker-hub.mjs` drives the Worker's Hub
  REST API and auth routing against a fake Durable Object runtime.
- Unit tests for every module extracted below, `npm test` (runs `check.sh`), and `check.sh` guards for a stale `worker.js` (in CI), for the
  bridge's self-restart watch list, and against helper modules spawning processes.

### Changed

- **Node 22 or newer is now required.** The bridge uses the global `WebSocket`, which Node 18 and 20 lack; on those versions it died on
  startup. CI, `engines`, `run.sh` and the docs now say 22.
- `bridge.mjs` (1025 lines, about 25 module-level globals) is split into tested modules: `turn-events`, `turn-policy`, `models`,
  `session-store`, `compaction`, `room-dispatch`, `uploads`, `schedule-cli`. Spawns and the `ws.onmessage` handlers stay in `bridge.mjs`.
- The Worker's pure helpers and room create/settings/order validation moved to `worker-lib.mjs`, inlined into `worker.js` like `budget.mjs`.
  `build.sh` and `deploy.sh` read one list of inlined modules (`inline-modules.txt`) instead of two hand-written ones.
- A settings request with an invalid `cwd` is now rejected before any field is applied; it used to answer 400 after already changing the room's
  model, tier, effort and `runLocal` in memory.
- `CONTRIBUTING.md` and the pull request template describe the real workflow and checks.

### Fixed

- **Security:** a driver's `claude` no longer inherits `JAM_KEY` when it runs without the macOS sandbox (other platforms, or
  `JAM_DRIVER_SANDBOX=off`). Only the Seatbelt path scrubbed it before.
- Upload size and chunk count are bounded before anything is allocated.
- A stuck turn killed by the watchdog is now retried once, as the message shown to the room promised.
- The bridge now restarts itself when `turntext.mjs` changes; it was never on the watch list.
- CI's `check` job had been red on `main`: three scheduler hook tests only passed on a machine that had `~/.jam/nightly.sha256`.
- Path handling in `approve-hook.mjs` on Windows (inside-workdir and sensitive-path checks never matched backslash paths), and the exec-bit
  guard in `check.sh` under Git Bash.

## [0.2.1]

Earlier history is in the git log.

[Unreleased]: https://github.com/jaypetez/jam/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/jaypetez/jam/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/jaypetez/jam/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/jaypetez/jam/releases/tag/v0.3.0
