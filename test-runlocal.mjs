// "Run commands on this machine" (room.runLocal). Drives the REAL hook as a subprocess (the way Claude Code does), so it
// exercises the actual dispatch path, not a copy of the logic.
import { spawnSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathsOverlap, runLocalVerdict } from "./sandbox.mjs";
const REPO = path.dirname(fileURLToPath(import.meta.url));
const room = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "runlocal-"));
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "✓ " : "✗ ") + m); };
// No JAM_HOST/JAM_KEY: anything that would need an Allow card dies at "no room to ask" with exit 2 instead of hanging on the network.
const hook = (tool, input, env) => spawnSync("node", [path.join(REPO, "approve-hook.mjs")], { input: JSON.stringify({ tool_name: tool, tool_input: input }), encoding: "utf8", timeout: 20000,
  env: { PATH: process.env.PATH, HOME: os.homedir(), JAM_CWD: room, JAM_FROM: "t", ...env } });
const D = { JAM_FROM_ROLE: "driver" }, DL = { JAM_FROM_ROLE: "driver", JAM_RUN_LOCAL: "1" };
const sh = c => ({ command: c });
ok(hook("Bash", sh("node build.js"), D).status === 2, "driver, flag off: a risky command still needs approval (control)");
ok(hook("Bash", sh("node build.js"), DL).status === 0, "driver, flag on: a risky command runs without an Allow card");
ok(hook("Bash", sh("rm -rf ./dist && npm install && curl https://example.com"), DL).status === 0, "driver, flag on: rm -rf / npm / curl run");
ok(hook("Bash", sh("cat ~/.jam-key"), DL).status === 2, "flag on: touching .jam-key is still gated");
ok(hook("Bash", sh("echo x > ~/.zshrc"), DL).status === 2, "flag on: writing a shell rc file is still gated");
ok(hook("Bash", sh("printenv"), DL).status === 2, "flag on: printenv (owner credentials) is still gated");
ok(hook("Bash", sh("cat ~/.jam/scheduled.json"), DL).status === 2, "flag on: ~/.jam control files are still gated");
ok(hook("Bash", sh("git commit -am x"), DL).status === 2, "flag on: git writes stay owner-only");
ok(hook("Write", { file_path: "/etc/hosts", content: "x" }, DL).status === 2, "flag on: Write outside the room is still gated");
ok(hook("Write", { file_path: path.join(room, ".claude", "settings.json"), content: "{}" }, DL).status === 2, "flag on: config plants are still gated");
ok(hook("mcp__claude_ai_Gmail__send_message", {}, DL).status === 2, "flag on: MCP tools are still gated");
ok(hook("Bash", { command: ["node x"] }, DL).status !== null, "malformed command doesn't crash the hook");
ok(hook("Bash", sh("node build.js"), { JAM_FROM_ROLE: "scheduler", JAM_RUN_LOCAL: "1" }).status === 2, "the scheduler role does not inherit the switch");
ok(hook("Bash", sh("node build.js"), { JAM_FROM_ROLE: "driver", JAM_RUN_LOCAL: "true" }).status === 2, "only the exact value \"1\" counts");
ok(hook("Bash", sh("node build.js"), { JAM_RUN_LOCAL: "1" }).status === 2, "no role at all: not trusted");
// wiring: the bridge sets it only for driver turns of a room whose flag is strictly true, and never inherits it
const bridge = fs.readFileSync(path.join(REPO, "bridge.mjs"), "utf8"), workerSrc = fs.readFileSync(path.join(REPO, "worker.src.js"), "utf8"), workerLib = fs.readFileSync(path.join(REPO, "worker-lib.mjs"), "utf8"), worker = workerSrc + "\n" + workerLib; // room-settings validation moved to worker-lib.mjs (2026-10-09)
// behaviour of the predicate the bridge actually calls (not a grep over its source)
const J = fs.realpathSync(REPO), S = path.join(fs.realpathSync(os.homedir()), ".jam"), H = fs.realpathSync(os.homedir());
const v = cwd => runLocalVerdict({ runLocal: true, sandboxed: true, cwdReal: cwd, jamCode: J, jamState: S }).on;
ok(v("/") === false, "overlap: a room at / is refused (it contains jam's code)");
ok(v(H) === false && v(path.dirname(J)) === false, "overlap: $HOME and the repo root (~/claude) are refused");
ok(v(J) === false && v(J + "/") === false && v(path.join(J, "sandbox")) === false, "overlap: jam's own dir (with/without trailing slash) and its subdirs are refused");
ok(v(S) === false && v(path.join(S, "sessions")) === false, "overlap: ~/.jam and below are refused");
ok(v("/tmp/some-project") === true && v(path.join(H, "projects", "x")) === true, "overlap: an unrelated project dir is allowed");
ok(v(J + "-other") === true, "overlap: a sibling that merely shares a name prefix is allowed");
ok(pathsOverlap("/", "/") === true && pathsOverlap("/a/b", "/a") === true && pathsOverlap("/a", "/ab") === false, "pathsOverlap edge cases");
ok(runLocalVerdict({ runLocal: true, sandboxed: false, cwdReal: "/tmp/x", jamCode: J, jamState: S }).on === false, "no sandbox on this turn: never card-free");
ok(["true", 1, "1", undefined, null, false].every(f => runLocalVerdict({ runLocal: f, sandboxed: true, cwdReal: "/tmp/x", jamCode: J, jamState: S }).on === false), "only a strict boolean true enables it");
ok(bridge.indexOf("sb.env.JAM_RUN_LOCAL = \"1\"") > 0 && bridge.indexOf("sb.env.JAM_RUN_LOCAL = \"1\"") < bridge.indexOf("const child = r.child = spawn("), "bridge: the flag is set on the sandbox env BEFORE the child is spawned (env is copied at spawn)");
ok(!/[^.]env\.JAM_RUN_LOCAL = "1"/.test(bridge) && /delete env\.JAM_RUN_LOCAL;/.test(bridge), "bridge: never set on the bare env; any inherited value is cleared");
ok([...bridge.matchAll(/type: "session"[^}]*\}/g)].every(m => /runLocal/.test(m[0])), "bridge: every session event carries runLocal (else the UI box desyncs on a model change)");
ok(hook("Bash", { command: "node x", dangerouslyDisableSandbox: true }, DL).status === 2, "flag on: dangerouslyDisableSandbox is never card-free");
ok(/r\.runLocal = b\.runLocal === true/.test(worker), "worker: stored as a strict boolean");
ok(!/runLocal/.test((workerSrc.match(/p === "\/rooms" && req\.method === "POST"[\s\S]*?return json\(\{ ok: true, room: r \}\)/) || [""])[0]) && !/runLocal/.test((workerLib.match(/export function parseNewRoom[\s\S]*?\n}\n/) || [""])[0]) && /export function parseNewRoom/.test(workerLib), "worker: room creation can't pre-enable it");
fs.rmSync(room, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed.`); process.exit(fail ? 1 : 0);
