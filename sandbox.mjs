// Driver sandbox: the Bash tool of non-owner `claude -p` turns runs under a kernel-enforced Seatbelt profile (sandbox/driver.sb).
// Regex classification of shell (approve-hook.mjs) can't be airtight — quote-splitting, globs, interpreters — and a driver's Bash
// used to be able to write anywhere the owner's account could and read the owner's credentials. Claude Code hands every Bash command
// to CLAUDE_CODE_SHELL_PREFIX; ours (sandbox/bashwrap.sh) applies the profile to that command only. The `claude` process itself is
// not wrapped (it needs the keychain and its own config), and its in-process file tools stay gated by the hook.
// Owner and scheduler turns are untouched. JAM_DRIVER_SANDBOX=off disables it; non-macOS has no Seatbelt.
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DRIVER_SB = path.join(here, "sandbox", "driver.sb");
export const BASH_WRAP = path.join(here, "sandbox", "bashwrap.sh");
// Claude Code passes hook commands through CLAUDE_CODE_SHELL_PREFIX too (not just Bash-tool commands), so the wrapper must let the
// approval hook run outside the sandbox with its full env (it needs JAM_KEY to reach the room). Matched by exact string, which
// a driver's Bash command can never equal: those always arrive as `source <snapshot> ... eval '<their command>'`.
export const HOOK_CMD = `"${process.execPath}" "${path.join(here, "approve-hook.mjs")}"`;
const SECRET_ENV = /^(SSH_AUTH_SOCK|SSH_AGENT_PID|AWS_|GOOGLE_APPLICATION|GH_|GITHUB_|GITLAB_|NPM_|NODE_AUTH|OPENAI_|CLOUDFLARE_|CF_|STRIPE_|HF_TOKEN)|(SECRET|PASSWORD|PRIVATE_KEY)/i;

// Returns null when sandboxing doesn't apply here, else { env, scratch }: the environment to give the driver's `claude` process.
// Throws when it should apply but can't — a driver turn must never silently run with an unsandboxed shell.
export function driverSandbox(cwd, turnId, baseEnv, opts = {}) {
  const penv = opts.env || process.env;
  if ((opts.platform || process.platform) !== "darwin" || penv.JAM_DRIVER_SANDBOX === "off") return null;
  if (!existsSync("/usr/bin/sandbox-exec") || !existsSync(DRIVER_SB) || !existsSync(BASH_WRAP)) throw new Error("sandbox-exec, sandbox/driver.sb or sandbox/bashwrap.sh is missing; refusing to run a driver turn with an unsandboxed shell");
  const scratch = path.join(realpathSync("/tmp"), "jam-driver-" + String(turnId).replace(/[^\w-]/g, "").slice(0, 16));
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const env = Object.fromEntries(Object.entries(baseEnv).filter(([k]) => !SECRET_ENV.test(k)));
  delete env.JAM_KEY; // the driver's claude never holds the hub key in its environment (any same-uid process can read another's env
                      // via sysctl, which Seatbelt can't block); the approval hook reads .jam-key from disk instead
  Object.assign(env, {
    CLAUDE_CODE_SHELL_PREFIX: BASH_WRAP, // (CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is NOT used: it strips JAM_* from the approval hook and forces the default permission mode)
   
    JAM_SB_HOOK_CMD: HOOK_CMD, JAM_SB_PROFILE: DRIVER_SB, JAM_SB_HOME: realpathSync(os.homedir()), JAM_SB_CWD: realpathSync(cwd), JAM_SB_SCRATCH: scratch, JAM_SB_UID: String(process.getuid()),
  });
  return { env, scratch };
}

// Kill whatever a driver turn left running (servers started with `&`, `( cmd & )` daemons): each Bash call is its own sandbox, so the
// driver can't signal an earlier call's processes, and nothing else would stop them. bashwrap.sh hands every command an fd on
// <scratch>/.turn, inherited by everything it starts; lsof finds the holders, plus anything whose cwd is in the scratch dir. Best-effort:
// a daemon that closed fd 19 and left the scratch dir escapes this (it is still sandboxed: room-only files, no localhost). Returns pids.
export function reapDriver(scratch, opts = {}) {
  if (!scratch || (opts.platform || process.platform) !== "darwin") return [];
  const lsof = args => { try { return execFileSync("/usr/sbin/lsof", args, { encoding: "utf8", maxBuffer: 64 << 20, timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }); } catch (e) { return String(e.stdout || ""); } }; // exits 1 when nothing matches
  const pids = new Set(lsof(["-t", path.join(scratch, ".turn")]).split(/\s+/).filter(Boolean).map(Number));
  let pid = 0; for (const l of lsof(["-a", "-d", "cwd", "-Fpn"]).split("\n")) {
    if (l[0] === "p") pid = +l.slice(1); else if (l[0] === "n" && (l.slice(1) === scratch || l.slice(1).startsWith(scratch + "/"))) pids.add(pid);
  }
  const killed = [];
  for (const p of pids) { if (!p || p === process.pid) continue; try { process.kill(p, "SIGKILL"); killed.push(p); } catch {} }
  return killed;
}

// Do two real paths contain, equal or sit inside each other? "/" contains everything (a naive startsWith(b + "/") gets "//" wrong).
export function pathsOverlap(a, b) {
  const norm = x => (x.length > 1 ? x.replace(/\/+$/, "") : x) || "/";
  a = norm(a); b = norm(b);
  const pre = x => (x === "/" ? "/" : x + "/");
  return a === b || b.startsWith(pre(a)) || a.startsWith(pre(b));
}
// Should this driver turn get card-free Bash? Only when the Seatbelt is applied and the room's directory neither contains nor sits
// inside jam's own code or state dir (a card-free interpreter there could rewrite the bridge/hook or the replayed queue files).
export function runLocalVerdict({ runLocal, sandboxed, cwdReal, jamCode, jamState }) {
  if (runLocal !== true) return { on: false, why: "" };
  if (!sandboxed) return { on: false, why: "this turn has no sandbox" };
  if (pathsOverlap(cwdReal, jamCode) || pathsOverlap(cwdReal, jamState)) return { on: false, why: "the room's directory overlaps jam's own files" };
  return { on: true, why: "" };
}
