# Contributing to jam

Thanks for your interest in contributing! This document explains how to propose changes.

By participating in this project you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting bugs and requesting features

- Search [existing issues](https://github.com/jaypetez/jam/issues) first to avoid duplicates.
- Open a new issue using the **Bug report** or **Feature request** template and fill in every section.
- **Security vulnerabilities must not be reported in public issues.** Follow [SECURITY.md](SECURITY.md) instead.

## Development setup

You need `bash`, Node 22 or newer (the bridge uses the global `WebSocket`), `git`, and the usual `shasum`, `base64`, `sed`, `awk`. On macOS and
Linux that is all. On **Windows** use WSL or a container: `check.sh` assumes POSIX paths and executable bits, and several hook tests fail
under Git Bash. [AGENTS.md](AGENTS.md#verify-a-change) has a one-line Docker command that runs the gate exactly as CI does.

```sh
git clone https://github.com/jaypetez/jam.git && cd jam
npm ci
npm test        # = ./check.sh, the whole offline gate; no network and no credentials needed
```

## Making changes

1. Fork the repository and create a branch from `main`:

   ```sh
   git checkout -b my-change
   ```

2. Make your change. Keep each pull request focused on a single change; unrelated fixes belong in separate PRs. When behaviour changes, add or
   extend a test: the pure modules (`turn-policy`, `models`, `compaction`, `worker-lib`, ...) each have a `*.test.mjs`, and
   `test-bridge-turn.mjs` and `test-worker-hub.mjs` cover the bridge and the Worker's REST surface end to end, offline.
3. Run the checks CI runs:

   ```sh
   npm test                                              # offline gate
   node route.test.mjs                                   # or any single test: they are plain Node scripts
   npx markdownlint-cli2 "**/*.md" "#node_modules"       # if you touched Markdown
   ```

   CI also lints workflows with [actionlint](https://github.com/rhysd/actionlint). `./run-tests.sh` is the end-to-end suite against a deployed
   Worker; it creates and deletes `test-*` rooms there, so only run it against a Worker you own (see [Tests](README.md#tests)).
4. Push your branch and open a pull request against `main`, filling in the pull request template.

### Rules CI enforces

`check.sh` fails the build, with a message saying why, if you break one of these:

- `worker.js` is a generated bundle. After editing `worker.src.js`, `ui.html`, `budget.mjs`, `worker-lib.mjs` or `inline-modules.txt`, run
  `./build.sh` and commit the regenerated `worker.js`.
- Every `spawn()` in `bridge.mjs` needs an `.on("error")` on the same variable, both `ws.onmessage` handlers must wrap their body in one
  `try { } catch`, and the helper modules the bridge imports must not spawn.
- Shebang scripts are mode `100755` in git (`git update-index --chmod=+x <file>` on Windows) with LF line endings.
- A new module that `bridge.mjs` imports must be added to its self-restart watch list.

Security-sensitive code (`approve-hook.mjs`, `sandbox.mjs`, turn spawning) has extra invariants: read the Security invariants in
[CLAUDE.md](CLAUDE.md) first, and add a test case for any new risky command shape. The wire protocol is documented in
[docs/PROTOCOL.md](docs/PROTOCOL.md); update it with any message change. Contributing with an AI coding agent? Point it at
[AGENTS.md](AGENTS.md).

## Review and merging

- Every pull request needs an approving review from the maintainer ([@jaypetez](https://github.com/jaypetez)) before it can be merged.
- All CI checks must pass and all review conversations must be resolved.
- Pushing new commits after approval dismisses the approval, so the latest changes are always reviewed.
- Pull requests are merged with **squash merge**, so write a clear PR title — it becomes the commit message on `main`.
- Workflows on pull requests from forks only run after a maintainer approves them.

## License

By contributing, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).
