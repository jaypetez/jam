# Changelog

All notable changes to jam are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/). Releases are tagged `vX.Y.Z` on `main`; a release does not deploy anything, so a running
Worker only changes when its owner runs `./deploy.sh`.

## [Unreleased]

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

[Unreleased]: https://github.com/jaypetez/jam/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/jaypetez/jam/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/jaypetez/jam/releases/tag/v0.3.0
