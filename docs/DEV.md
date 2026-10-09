# The dev loop

jam can run entirely on one machine, with nothing external: the real Worker on a real Durable Object runtime, the real bridge, a deterministic
fake `claude`, and real headless Chromium. Everything lives in a throwaway directory; nothing touches production or your `~/.jam`.

| Command | What it does | Time |
| --- | --- | --- |
| `npm test` | `check.sh`: the offline gate (syntax, unit tests, hook and sandbox tests, the bridge against a fake hub). No browser, no wrangler needed to run. | about 1 min |
| `npm run test:stack` | Starts the local stack and checks the Room and Hub Durable Objects over real websockets, a turn through a real bridge, and clean teardown. | about 5 s |
| `npm run e2e` | The live end-to-end suite (`test.mjs`, `compact.test.mjs`, the Playwright tests, ...) against the local stack. | about 3 min |
| `npm run verify` | All three. This is the command to run before you say a change works. | about 5 min |
| `npm run dev` | The stack for you to click around in: prints owner, driver and viewer links, answers with the fake claude. Ctrl-C stops it. | |
| `npm run e2e:real` | The same suite with your real `claude` (spends quota; an opt-in smoke test of the real CLI contract). | |
| `npm run setup:e2e` | One-time: downloads the Chromium build your Playwright version needs. | |

First time on a machine: `npm ci && npm run setup:e2e`. Needs Node 22+ and `bash` (Git Bash is fine on Windows).

## How it fits together

```text
npm run e2e ─ scripts/e2e.mjs ─┬─ scripts/stack.mjs ─ wrangler dev --local ─ workerd ─ Hub + Room Durable Objects   (http://127.0.0.1:<port>)
                               ├─ bridge.mjs  (real)  ── JAM_CLAUDE ──▶ dev/fake-claude.mjs ─▶ approve-hook.mjs (real)
                               └─ test.mjs, compact.test.mjs, test-boot.mjs, ...  (the same files `run-tests.sh` runs against production)
```

- **`scripts/stack.mjs`** builds `worker.js`, starts it under `wrangler dev --local` with a generated `wrangler.toml` and `.dev.vars` in a temp
  directory (so the repo's config is untouched and the key never appears in argv), waits for `/health` to report the build hash it just built, and
  kills the whole process tree on stop, exit and Ctrl-C. A temp `HOME` keeps bridge state (`~/.jam`) away from yours.
- **`jam-url.mjs`** decides the scheme: a loopback host is plain `http`/`ws`, everything else is `https`/`wss`, and `JAM_SCHEME` overrides. The
  approval hook carries its own inlined copy of that rule on purpose (see its comment); `jam-url.test.mjs` keeps the two identical.
- **`scripts/e2e.mjs`** runs the stages of `run-tests.sh` (a main bridge, an auth stage with a stub, a runlocal stage, two model-switch stages) and
  fails if a test exits non-zero, prints a `FAIL`, or never prints a `PASS` (a test that silently did nothing).

`run-tests.sh` is still how you run those same test files against a **deployed** Worker. Do not run it unless you own that Worker.

## The fake claude

`dev/fake-claude.mjs` is what the bridge spawns instead of `claude`. The bridge runs it exactly like the real CLI (same arguments, prompt on stdin,
stream-json on stdout). What it says comes from `dev/fake-claude-rules.mjs`, a table of *prompt pattern, then a script of steps*. The rules are the
minimum a real Claude would have done for the prompts the live tests send, so the suite needs no quota, login or network.

What makes it a faithful stand-in rather than a canned reply:

- It writes Claude Code's own session transcript, which the bridge reads to choose `--resume` or `--session-id` and to write a compaction handoff
  when no model can reload a session. `--resume` of an unknown session fails the way the real CLI does.
- Every tool call goes through the **real** `approve-hook.mjs`, so approval cards and blocks come from the real code path.
- It reports a realistic context size (about 15.5k tokens on turn one), so the bridge's window and compaction logic fires.
- It really decodes the PNG in the upload test to name its colour, and remembers facts across `/compact` (fact, handoff, fresh session).

What it never does: run arbitrary commands. Bash calls go to a small simulated shell (`echo`, `sleep`, `ls`, `pwd`), so it is safe to type into
under `npm run dev`. Try `SCEN:ok`, `SCEN:env`, `SCEN:crash-once` or `SCEN:cap-once` in a message.

It is a **model** of the CLI, not the CLI. If Claude Code's stream-json format changes, this can drift; `npm run e2e:real` is the check against the
real thing, and `turn-events.test.mjs` pins the event shapes the bridge understands.

### Adding a rule

1. Add an entry to `RULES` in `dev/fake-claude-rules.mjs`: a regex over the user's text, and a function returning steps (`say`, `sleep`, `tool`).
   A `tool` step can branch on whether the approval hook allowed or blocked the call.
2. Add the exact prompt your test sends to `fake-claude.test.mjs` and assert the script it produces. Rules are pure, so this needs no processes.
3. `npm run e2e -- --only <your test file>` to see it work end to end.

## Debugging

- `npm run e2e -- --only compact --keep` runs one test and keeps the state directory (Worker logs, bridge `~/.jam`, the room directories).
- `npm run dev -- --keep` does the same for the interactive stack. Per-test output is in `logs/e2e/` (CI uploads it when a run fails).
- A test that hangs usually has a fake-claude rule missing for its prompt: the room shows `Fake claude heard: ...` instead of the expected answer.

## Limits, stated plainly

- **`runlocal.test.mjs` runs on macOS only.** "Run commands on this machine" is honoured only under the Seatbelt sandbox, which does not exist
  elsewhere, so the stage is reported SKIPPED (never passed) on Windows and Linux. `test-sandbox-exec.mjs` is likewise macOS-only.
- The fake claude cannot see pixels beyond the one PNG decoder, cannot reason, and does not exercise Claude's real tool use. Those stay with
  `npm run e2e:real`.
- `deploy.sh`, Cloudflare account behaviour and real DNS are never exercised here.
