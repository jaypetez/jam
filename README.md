![jam: a shared Claude Code room. Ann, Dee and Sam join by link, ask Claude to fix a test, and Ann approves a risky push.](docs/hero.svg)

# jam — shared Claude Code sessions

[![CI](https://github.com/jaypetez/jam/actions/workflows/ci.yml/badge.svg)](https://github.com/jaypetez/jam/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-3c873a.svg)](package.json)

**Several people, one Claude Code session, from any browser.** Each **room** is a Claude Code session running in one directory on a machine
you control (the **host**). People join with a short invite link, everyone sees the same streamed transcript, tool calls and uploads, and
Claude sees every message tagged with who said it. Owners approve anything risky a driver asks for.

[Quick start](#quick-start) · [What you get](#what-you-get) · [Setup](#setup-about-five-minutes) · [Security](#security) · [Protocol](docs/PROTOCOL.md) · [Contributing](CONTRIBUTING.md)

```text
 browser ──┐                                       ┌── claude -p --resume … (room A)
 browser ──┼─ wss ─▶ Cloudflare Worker + DOs ◀─ wss ─┤   bridge on the host
 browser ──┘         (rooms, transcript, invites)     └── claude -p --resume … (room B)
```

Native Claude Code is single-user. jam sidesteps that using one Claude subscription on the host.

## Quick start

You need a Cloudflare account (free plan), Node 22+, and Claude Code logged in (`claude login`) or an `ANTHROPIC_API_KEY`.

```bash
git clone https://github.com/jaypetez/jam.git && cd jam
./setup.sh      # generates the owner key, deploys the Worker, prints your lobby link
./run.sh        # starts the bridge on this machine (leave it running)
```

Open the lobby link, create a room (a name and a directory on the host), open it, and hit **Invite** to send short links. The
[full setup](#setup-about-five-minutes) covers deployment options, a custom domain and auto-start.

## What you get

- **Rooms.** One session per directory. Create as many as you like from the lobby; the bridge picks them up live.
  Switch rooms from the sidebar.
- **Auto-routing (default).** Each message is weighed and sent to the right model: chatter to Haiku, small changes to
  Sonnet, real work to Opus (Fable is never auto-routed; pin it by hand). A session whose context outgrows the smaller windows is pinned to the 1M model
  automatically — that part is correctness, not thrift. A crashed turn retries one weight heavier. The rules live in
  `route.mjs` with unit tests in `route.test.mjs`, and every decision is appended to `~/.jam/routing.jsonl` so the
  weights can be calibrated against real cost and duration. Pin a room to one model from the sidebar if you'd rather.
- **Compaction, automatic.** Every turn re-reads the whole conversation, so a long session gets slow and expensive
  and falls off the small models. When context passes 150k the bridge compacts right after the current turn; when a
  room has been quiet for five minutes with 90k+ it compacts in the gap so nobody waits. Anyone can type `/compact`
  (or click *compact* beside the gauge). Compaction asks Claude to write a handoff (people, state, decisions, open
  items, lessons, last exchanges), saves it to `~/.jam/sessions/<room>-handoff-<time>.md`, starts a fresh session, and
  feeds the handoff into its first turn. The transcript in the room is untouched. Thresholds: `JAM_COMPACT_AT`,
  `JAM_COMPACT_IDLE_AT`, `JAM_COMPACT_IDLE_MIN`. Each compaction is logged to `~/.jam/compactions.jsonl`.
- **Roles.** *Owner* runs unimpeded, approves, invites. *Driver* talks to Claude. *Viewer* watches.
- **Approvals.** When a driver's request makes Claude do something risky (deletes, pushes, deploys, package installs,
  inline `python -c` / `sh -c`, writing outside the room's directory, …) the call pauses and the owner gets an
  Allow / Deny card in the room. The tab title shows how many are waiting.
- **Short invite links.** `https://<your-domain>/j/<12-char token>`. Per person, revocable, optionally name-locked.
  The key moves into a cookie on first visit and is scrubbed from the address bar.
- **Screenshots and files.** Paste, drag, or attach. Files land in `~/.jam/uploads/<room>/` on the host and Claude
  gets the paths; everyone else sees a thumbnail.
- **@teammates.** Subagents in `~/.claude/agents/*.md` show up as `@name` mentions with autocomplete.
- **Live everything.** Streaming replies, collapsible tool cards with diffs and output, presence, typing indicators,
  a `.:working:.` status with the current tool and elapsed time, and a red banner when the bridge is dead.
- **Queue you can see.** Messages sent while Claude is busy queue in order and can be cancelled before they run.
- **History that survives.** Transcript stored per entry (last 5,000 events), "Load earlier" pagination, one-click
  Markdown export, per-turn and per-view cost.
- **Resilient.** Messages sent while the bridge is disconnected are replayed when it returns. A Claude process that
  dies without answering is retried once. Under launchd/systemd the bridge restarts itself when its code changes.
- **Browser tool.** Claude drives headless Chromium, takes screenshots that post live to the room. Click screenshots to auto-generate CLI commands.
- **Co-browsing.** Click anywhere on a screenshot → Claude runs the click at those coordinates. Visual debugging.
- **Owner boot.** Owner clicks "-" next to any member, confirms, and they're revoked and cannot rejoin unless re-invited.
- **Transcript search.** Live keyword filter in the sidebar.

## Credentials & cost

**You bring your own Claude.** The bridge runs `claude` CLI on your machine using one of two auth paths:

- **Claude subscription:** Already logged in? `claude login` works. The bridge inherits your session.
- **Anthropic API key:** Set `ANTHROPIC_API_KEY` in your shell, then run the bridge. Full billing goes to your Anthropic console account.

Either path works; pick what you have. You keep all prompts, files, and billing — Null Agency never touches them. No API key exchange, no credential sharing.

**You own your Cloudflare Worker.** Deploy to your free-tier Cloudflare account (~$0/month unless you exceed free limits). The Worker stores room metadata and transcripts in Durable Objects; session state lives on your host in `~/.jam/`.

**Hosting cost is separate from Claude cost.** You pay only for Cloudflare control-plane infrastructure (room sync, presence, invites). Claude usage stays on your account (subscription or API key, whichever you chose). Multiple people can share one room and one session, or each bring their own Claude credentials.

## Setup (about five minutes)

**Requirements:**

- Cloudflare account (free plan is fine; sign up at [cloudflare.com](https://cloudflare.com))
- Node 22+ installed (`node --version`)
- **One of:**
  - Claude Code installed and logged in (`claude login` in your terminal), OR
  - Anthropic API key (set `ANTHROPIC_API_KEY` environment variable)

**Steps:**

```bash
git clone https://github.com/jaypetez/jam.git jam && cd jam
./setup.sh            # generates the owner key, deploys the Worker, prints your lobby link
./run.sh              # starts the bridge on this machine (keep running)
```

Then open the **Lobby URL** printed by `setup.sh` in your browser. Create a room (pick a name and a directory on your machine), open it, and hit **Invite** to send short links to others.

**Deployment options:**

- **With wrangler (recommended):** Install `npm i -g wrangler`, run `wrangler login`, then `./setup.sh`. (Fastest.)
- **Without wrangler:** Fill in `CF_ACCOUNT_ID` and `CF_API_TOKEN` in `.env` (see `.env.example`), then `./setup.sh`. ([How to get API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/))

Then open the lobby link, create a room (name + directory on the host + optional model), open it, and hit **Invite**.

### Custom domain

The Worker answers at `https://jam.<your-account>.workers.dev` by default. To use your own hostname, add a custom
domain on the Worker in the Cloudflare dashboard (Workers → jam → Settings → Domains) or set `routes` in
`wrangler.toml`. Put the hostname in `.env` as `JAM_HOST` so the bridge connects to it.

### Auto-start

**macOS** — `io.nullagency.jam.plist` is a launchd agent that keeps the bridge alive across reboots and crashes, and
lets it restart itself after a `git pull`:

```bash
sed "s#/Users/YOU/claude/jam#$PWD#g" io.nullagency.jam.plist > ~/Library/LaunchAgents/io.nullagency.jam.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.nullagency.jam.plist
launchctl kickstart -k gui/$(id -u)/io.nullagency.jam    # force a restart later
```

**Linux** — a systemd user unit that runs `run.sh` with `Restart=always`. **Windows** — `run.cmd` (no supervisor
included; Task Scheduler works).

## Links

| Link | Who | Notes |
| --- | --- | --- |
| `/?k=<owner key>` | you | Lobby: create/delete rooms. Key is stored in a cookie after the first visit. |
| `/r/<room>` | you | Room as owner (cookie), or `/r/<room>?k=<owner key>` once |
| `/j/<token>` | invitees | Personal short link; role and optional fixed name baked in |

Invite tokens are 12 characters from a 32-symbol alphabet (about 60 bits). Revoke from the sidebar; the person is
disconnected immediately. "Sign out" in the sidebar forgets the key on that device.

## Security

**Found a vulnerability?** Please report it privately — see [SECURITY.md](SECURITY.md). Do not open a public issue.

The bridge runs Claude with permissions skipped, in the room's directory, on your machine. Owners are trusted
completely. Drivers are gated by the approval hook (`approve-hook.mjs`, a Claude Code PreToolUse hook) for the
patterns listed at the top of that file; extend the list to taste. It's a guardrail, not a sandbox: a determined
driver can still read files in the room's directory. Invite only people you'd hand a terminal to, and keep the owner
key private.

Rotate the owner key: `openssl rand -hex 24 > .jam-key && ./deploy.sh`, then restart the bridge.

## Tests

jam tests itself end to end, on your machine, with nothing external. `npm run verify` is the command to run before you say a change works:

```bash
npm ci && npm run setup:e2e     # once: dependencies, and the Chromium build the browser tests need
npm run verify                  # the whole loop, about five minutes
```

- `npm test` (`./check.sh`) is the fast offline gate CI runs: syntax checks, unit tests for the router, catalog, schedules, budgets and every bridge
  module, the approval-hook and driver-sandbox tests, and the real bridge against a fake hub and a stub `claude`. No network, no credentials.
- `npm run test:stack` starts the **real Worker on workerd** (real Durable Objects) and a real bridge in a throwaway directory and checks roles,
  presence, a full turn, transcript storage across a reconnect, revocation, and that teardown leaves nothing behind.
- `npm run e2e` runs the live end-to-end suite (protocol, uploads, `/compact`, model switching, host login, status bar, reconnect, boot and
  co-browsing in real Chromium) against that local stack, answered by a deterministic fake `claude`. `npm run e2e:real` uses your own `claude`.
- `npm run dev` runs the same stack for you to click around in.

Any single test is `node <file>` or `npm run e2e -- --only <name>`. `./run-tests.sh` runs the same live suite against a **deployed** Worker (it
creates `test-*` rooms there, so use it only on a Worker you own). CI runs `check`, `lint` and `e2e`. See [docs/DEV.md](docs/DEV.md) and
[AGENTS.md](AGENTS.md); the macOS-only parts (`runlocal.test.mjs`, the sandbox) are reported as skipped elsewhere, never as passed.

## Files

- `bridge.mjs` — host-side bridge, one Claude session per room, wiring only; its logic lives in `turn-events.mjs`, `turn-policy.mjs`,
  `models.mjs`, `session-store.mjs`, `compaction.mjs`, `room-dispatch.mjs`, `uploads.mjs` and `schedule-cli.mjs`, each with a `*.test.mjs`
- `approve-hook.mjs` — the approval gate; `sandbox.mjs` and `sandbox/` — the macOS driver sandbox
- `route.mjs` + `route.test.mjs` — the auto-router and its tests; `tune-router.mjs`, `catalog.mjs`, `schedule.mjs`, `budget.mjs`
- `worker.src.js` — Worker + `Hub` DO (rooms, tokens, bridge/lobby sockets) + `Room` DO (transcript, sockets, approvals, queue);
  `worker-lib.mjs` — its pure helpers and validation
- `ui.html` — the whole UI, embedded into `worker.js` at build time by `build.sh` (which also inlines the modules in `inline-modules.txt`)
- `setup.sh`, `deploy.sh`, `run.sh` / `run.cmd`, `check.sh`, `run-tests.sh`, `wrangler.toml`, `.env.example`, `io.nullagency.jam.plist`
- `validate-worker-bundle.cjs` — pre-upload gate that `deploy.sh` runs on the built bundle (syntax, leaked secrets, DO bindings)

Sessions persist in `~/.jam/sessions/<room>.json`; delete one to start that room fresh. Uploads in
`~/.jam/uploads/<room>/`. Transcripts live in the Room DO.

## Documentation

- [docs/PROTOCOL.md](docs/PROTOCOL.md) — sockets, message types, roles and the REST API
- [docs/DEV.md](docs/DEV.md) — the local dev and test loop
- [SCHEDULER.md](SCHEDULER.md) — scheduled turns
- [AGENTS.md](AGENTS.md) and [CLAUDE.md](CLAUDE.md) — for AI coding agents working on jam
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md)

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and note
that this project follows a [Code of Conduct](CODE_OF_CONDUCT.md).

## License

MIT — see [`LICENSE`](LICENSE).
