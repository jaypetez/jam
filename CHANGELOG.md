# Changelog

All notable changes to jam are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/). Releases are tagged `vX.Y.Z` on `main`; a release does not deploy anything, so a running
Worker only changes when its owner runs `./deploy.sh`.

## [Unreleased]

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

[Unreleased]: https://github.com/jaypetez/jam/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/jaypetez/jam/releases/tag/v0.3.0
