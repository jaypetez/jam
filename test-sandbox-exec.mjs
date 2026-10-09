#!/usr/bin/env node
// Kernel-level check of the driver sandbox. Imports the REAL driverSandbox() from sandbox.mjs, takes the env it would give a driver's
// `claude` process, and runs commands through the REAL sandbox/bashwrap.sh exactly as Claude Code does (CLAUDE_CODE_SHELL_PREFIX
// hands the wrapper one command string). Nothing here is a hand-copied copy of the logic.
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import http from "node:http";
import { driverSandbox, BASH_WRAP, HOOK_CMD } from "./sandbox.mjs";

let pass = 0, fail = 0; const ok = (c, n) => { c ? pass++ : fail++; console.log(`${c ? "✓" : "✗"} ${n}`); };
if (process.platform !== "darwin") { console.log("skip: Seatbelt is macOS-only"); process.exit(0); }

const HOME = fs.realpathSync(os.homedir()), REPO = fs.realpathSync(path.dirname(new URL(import.meta.url).pathname));
const room = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "sbx-room-"))); fs.mkdirSync(path.join(room, ".git"));
const tag = `jamcanary-${process.pid}`;
const canaries = [`${HOME}/.${tag}`, `${HOME}/.zshrc.${tag}`, `${HOME}/.claude/projects/${tag}`, `${HOME}/.claude/settings.${tag}.json`, `${HOME}/.claude.json.${tag}`, `${REPO}/${tag}`, `${room}/../${tag}-outside`, `/private/tmp/claude-abcd-cwd`];
const clean = () => { for (const c of canaries) try { fs.rmSync(c, { force: true }); } catch {} };
clean();

const base = { ...process.env, SHELL: process.env.SHELL || "/bin/zsh", JAM_KEY: "FAKE-HUB-KEY", ANTHROPIC_API_KEY: "FAKE-API-KEY", SSH_AUTH_SOCK: "/tmp/fake-agent", JAM_HOST: "h", JAM_ROOM: "r", MY_SERVICE_TOKEN: "FAKE-TOKEN", DB_PASSWORD: "FAKE-PW", CLAUDE_CODE_OAUTH_TOKEN: "FAKE-OAUTH" };
const sb = driverSandbox(room, "test-" + process.pid, base);
ok(sb && sb.env.CLAUDE_CODE_SHELL_PREFIX === BASH_WRAP && fs.existsSync(BASH_WRAP), "driverSandbox() points CLAUDE_CODE_SHELL_PREFIX at the real wrapper");
ok(!("JAM_KEY" in sb.env), "the driver's claude process holds no JAM_KEY in its env (same-uid processes can read each other's env via sysctl)");
ok(!sb.env.SSH_AUTH_SOCK, "the ssh agent socket never reaches a driver turn");
const run = (cmd) => spawnSync(BASH_WRAP, [cmd], { cwd: room, encoding: "utf8", timeout: 30000, env: sb.env });
const denied = (cmd, name) => { const r = run(cmd); ok(r.status !== 0, `denied: ${name}`); return r; };
const allowed = (cmd, name) => { const r = run(cmd); ok(r.status === 0, `allowed: ${name}${r.status ? " — " + (r.stderr || "").trim().slice(0, 100) : ""}`); return r; };

// writes
allowed(`echo hi > ${room}/ok.txt`, "write inside the room");
allowed(`echo hi > ${sb.scratch}/ok.txt`, "write to the per-turn scratch dir");
allowed(`pwd -P >| /private/tmp/claude-abcd-cwd`, "claude's per-command cwd file");
allowed(`git -C ${room} status >/dev/null 2>&1 || true; node -e "console.log(1+1)"`, "ordinary tooling (node) runs");
denied(`echo x > ${room}/.git/HEAD`, "write to the room's .git");
denied(`echo x > ${HOME}/.${tag}`, "write to $HOME");
denied(`echo x >> ${HOME}/.zshrc.${tag}`, "append to an rc file path");
denied(`echo x > ${HOME}/.z''shrc.${tag}`, "quote-split path into $HOME");
denied(`echo x > ${HOME}/.claude/projects/${tag}`, "plant a file in ~/.claude/projects (session-transcript injection)");
denied(`echo x > ${HOME}/.claude/settings.${tag}.json`, "write ~/.claude/settings*.json");
denied(`echo x > ${HOME}/.claude.json.${tag}`, "write next to ~/.claude.json");
denied(`echo x > ${REPO}/${tag}`, "write into the owner's jam checkout");
denied(`echo x > ${room}/../${tag}-outside`, "write via .. out of the room");
denied(`python3 -c "open('${HOME}/.${tag}','w').write('x')"`, "python writing into $HOME");
denied(`node -e "require('fs').writeFileSync('${HOME}/.${tag}','x')"`, "node writing into $HOME");
denied(`ln -s ${HOME} ${room}/lnk && echo x > ${room}/lnk/.${tag}`, "symlink out of the room");
// reads
denied(`ls ${HOME}/.jam`, "list ~/.jam");
denied(`cat ${HOME}/.jam/scheduled.json`, "read ~/.jam/scheduled.json");
denied(`cat ${REPO}/.jam-key > /dev/null`, "read .jam-key");
denied(`cat ${REPO}/.jam-k* > /dev/null`, "read .jam-key via glob");
denied(`ln ${REPO}/.jam-key ${room}/k 2>/dev/null && cat ${room}/k > /dev/null`, "read .jam-key via a hardlink");
denied(`ls ${HOME}/.claude`, "list ~/.claude (credentials, other sessions' transcripts)");
denied(`cat ${HOME}/.claude.json > /dev/null`, "read ~/.claude.json (oauth account, MCP servers, trust)");
allowed(`ls ${HOME}/.claude/shell-snapshots > /dev/null`, "read the shell snapshot dir (the shell sources it every command)");
// credentials that live in IPC services rather than files
const kc = run(`security find-generic-password -s "Claude Code-credentials" -w 2>&1 | grep -c accessToken`);
ok((kc.stdout || "").trim() === "0", "keychain: the Claude Code OAuth token is not readable from a driver's shell");
// env the driver's shell sees
const envDump = run(`env`).stdout || "";
ok(!/JAM_KEY|FAKE-HUB-KEY|FAKE-API-KEY|ANTHROPIC_API_KEY|SSH_AUTH_SOCK/.test(envDump), "the shell's env has no hub key, API key or ssh agent");
ok(/JAM_ROOM=r/.test(envDump), "…but keeps the ordinary JAM_* context");
denied(`cat ${HOME}/.zshrc > /dev/null`, "read ~/.zshrc (home is deny-by-default)");
denied(`ls ${HOME}/Desktop`, "list ~/Desktop");
denied(`cat ${REPO}/.env > /dev/null`, "read the jam repo's .env (Cloudflare API key)");
denied(`cat ${REPO}/.dev.vars > /dev/null`, "read .dev.vars");
denied(`cat ${HOME}/.zsh_history > /dev/null`, "read shell history");
denied(`ls ${HOME}/Library/Application\ Support/Google`, "browser profile data");
fs.writeFileSync(path.join(room, ".env"), "SECRET=1\n"); fs.writeFileSync(path.join(room, ".dev.vars"), "K=1\n"); fs.writeFileSync(path.join(room, "readme.txt"), "hello\n");
denied(`cat ${room}/.env > /dev/null`, "read a .env even inside the room");
denied(`cat ${room}/.dev.vars > /dev/null`, "read .dev.vars inside the room");
denied(`cat ${room}/.e""nv > /dev/null`, "read .env via quote-split");
allowed(`cat ${room}/readme.txt > /dev/null`, "read ordinary room files");
// plants: files the owner's next claude/git/editor run would load with owner rights
denied(`mkdir -p ${room}/.claude && echo '{}' > ${room}/.claude/settings.json`, "plant room .claude/settings.json");
denied(`mkdir -p ${room}/.cl""aude && echo '{}' > ${room}/.cl""aude/settings.json`, "plant .claude/settings.json via quote-split");
denied(`echo x > ${room}/.claude.local.json`, "plant .claude*.json at the room root");
denied(`echo x > ${room}/CLAUDE.md`, "plant CLAUDE.md");
denied(`echo x > ${room}/CLAUDE.local.md`, "plant CLAUDE.local.md");
denied(`echo '{}' > ${room}/.mcp.json`, "plant .mcp.json");
denied(`echo x > ${room}/.envrc`, "plant .envrc");
denied(`mkdir -p ${room}/.vscode && echo '{}' > ${room}/.vscode/tasks.json`, "plant .vscode/tasks.json");
denied(`echo x > ${room}/.gitmodules`, "plant .gitmodules");
// the same plants one directory deeper, and a nested repo's .git (core.fsmonitor / hooks run when the owner runs git there)
denied(`mkdir -p ${room}/sub/.claude && echo '{}' > ${room}/sub/.claude/settings.json`, "plant sub/.claude/settings.json (nested)");
denied(`mkdir -p ${room}/a/b && echo x > ${room}/a/b/CLAUDE.md`, "plant a/b/CLAUDE.md (nested)");
denied(`mkdir -p ${room}/sub && echo '{}' > ${room}/sub/.mcp.json`, "plant sub/.mcp.json (nested)");
denied(`mkdir -p ${room}/pre/.claude && echo '{}' > ${room}/pre/.claude/settings.json && mv ${room}/pre ${room}/post`, "materialize then mv a .claude dir into place");
denied(`git init ${room}/nested >/dev/null 2>&1 && printf '[core]\\n\\tfsmonitor = touch ${room}/PROOF\\n' >> ${room}/nested/.git/config`, "nested repo with a core.fsmonitor in .git/config");
denied(`mkdir -p ${room}/n2/.git/hooks && echo x > ${room}/n2/.git/hooks/pre-commit`, "nested .git/hooks");
ok(!fs.existsSync(path.join(room, "PROOF")), "…and no fsmonitor payload ever ran");
allowed(`echo ok > ${room}/.gitignore && echo ok > ${room}/.github-note`, ".gitignore / .github* are ordinary files and stay writable");
// other drivers' scratch dirs and claude's per-project caches
const other = "/private/tmp/jam-driver-othertest-" + process.pid; fs.mkdirSync(other, { recursive: true }); fs.writeFileSync(path.join(other, "leak.txt"), "x");
denied(`cat ${other}/leak.txt > /dev/null`, "read another turn's scratch dir");
allowed(`echo mine > ${sb.scratch}/mine.txt && cat ${sb.scratch}/mine.txt > /dev/null`, "read/write this turn's own scratch dir");
fs.rmSync(other, { recursive: true, force: true });
const cliCache = `${HOME}/Library/Caches/claude-cli-nodejs`; if (fs.existsSync(cliCache)) denied(`ls ${cliCache}`, "list ~/Library/Caches/claude-cli-nodejs (every project's MCP logs)");
// claude's own tmp tree (background-task output is read back into context = prompt injection; also other sessions' output)
const claudeTmp = `/private/tmp/claude-${process.getuid()}`;
if (fs.existsSync(claudeTmp)) { denied(`echo x > ${claudeTmp}/${tag}`, "plant into claude's tmp tree"); denied(`ls ${claudeTmp}`, "list claude's tmp tree (other sessions' tool output)"); }
// the pasteboard (only checkable when the clipboard isn't empty)
const clip = spawnSync("pbpaste", { encoding: "utf8" }).stdout || "";
if (clip.length) ok((run(`pbpaste | wc -c`).stdout || "").trim() === "0", "pasteboard: a driver's shell reads nothing where an unsandboxed pbpaste reads the clipboard");
// env of the shell: nothing credential-shaped
const envNames = (run(`env`).stdout || "").split("\n").map(l => l.split("=")[0]);
ok(!envNames.some(n => /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|SSH_AUTH_SOCK/i.test(n)), "the shell's env has no credential-shaped variable at all");
// escape hatches
for (const c of ["launchctl list", "osascript -e 1", "open -a Finder", "crontab -l", "sudo -n true"]) denied(c, `exec ${c.split(" ")[0]}`);
denied(`cp /bin/launchctl ${room}/jc && ${room}/jc list`, "copy launchctl then run it (sandbox is inherited, not path-based)");
// localhost services
const srv = http.createServer((q, s) => s.end("secret")); await new Promise(r => srv.listen(0, "127.0.0.1", r)); const port = srv.address().port;
const bare = await new Promise(res => { const c = spawn("curl", ["-s", "-m", "3", `http://127.0.0.1:${port}/`]); let o = ""; c.stdout.on("data", d => o += d); c.on("close", () => res(o)); });
ok(bare === "secret", "control: the local server answers an unsandboxed curl");
const viaSb = run(`curl -s -m 3 http://127.0.0.1:${port}/`); ok(viaSb.status !== 0 && !viaSb.stdout.includes("secret"), "denied: curl to a localhost service");
srv.close();
// the approval hook is routed through the wrapper by Claude Code and must keep working (it needs JAM_KEY to reach the room)
const hookProbe = spawnSync(BASH_WRAP, [HOOK_CMD], { cwd: room, encoding: "utf8", timeout: 30000, env: { ...sb.env, JAM_FROM_ROLE: "driver", JAM_HOST: "127.0.0.1:9", JAM_ROOM: "r" }, input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf x" } }) });
ok(/could not reach the room for approval/.test(hookProbe.stderr || ""), "the hook, run through the wrapper with no JAM_KEY in env, reads .jam-key from disk and reaches the approval flow");
ok(!/no room to ask/.test(hookProbe.stderr || ""), "…and is not sandboxed into missing env");
const spoof = run(`${HOOK_CMD}; echo "$0"`); ok(!/could not reach the room/.test(spoof.stderr || "") , "a driver command that merely CONTAINS the hook string does not get the unsandboxed pass-through");
// run.sh: the bridge must not hold the hub key or Cloudflare credentials in its environment (readable by any same-uid process via sysctl)
{ const d = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "runsh-")); fs.mkdirSync(path.join(d, "bin"));
  fs.copyFileSync(path.join(REPO, "run.sh"), path.join(d, "run.sh")); fs.chmodSync(path.join(d, "run.sh"), 0o755);
  fs.writeFileSync(path.join(d, ".env"), 'JAM_HOST=jam.example.test\nJAM_CATALOG="off"\nJAM_KEY=LEAK-HUB-KEY\nCF_API_KEY=LEAK-CF-KEY\nCF_ACCOUNT_ID=LEAK-ACCT\n');
  fs.writeFileSync(path.join(d, "bin", "node"), "#!/bin/bash\nenv\nkill -TERM $PPID\n"); fs.chmodSync(path.join(d, "bin", "node"), 0o755);
  // run.sh supervises its child in a loop (3096bc4) and relaunches on any exit, so the fake node must stop it with TERM (its stop path) or this hangs forever; timeout is the backstop.
  const r = spawnSync("/bin/bash", [path.join(d, "run.sh")], { encoding: "utf8", timeout: 30000, killSignal: "SIGKILL", env: { PATH: `${d}/bin:/usr/bin:/bin`, HOME: os.homedir() } });
  ok(r.error === undefined && r.signal === null, "run.sh stopped on TERM instead of relaunching forever");
  ok(/JAM_HOST=jam\.example\.test/.test(r.stdout) && /JAM_CATALOG=off/.test(r.stdout), "run.sh still passes JAM_* settings from .env (quotes stripped)");
  ok(!/LEAK-/.test(r.stdout), "run.sh does not put JAM_KEY or CF_* credentials in the bridge's environment");
  fs.rmSync(d, { recursive: true, force: true }); }
// config switches
ok(driverSandbox(room, "x", base, { platform: "linux" }) === null, "non-macOS: no Seatbelt, returns null");
ok(driverSandbox(room, "x", base, { env: { JAM_DRIVER_SANDBOX: "off" } }) === null, "JAM_DRIVER_SANDBOX=off returns null");
// wiring in the bridge itself
const bridge = fs.readFileSync(path.join(REPO, "bridge.mjs"), "utf8");
ok(/item\.role === "driver"[^\n]*wrapDriver\(/.test(bridge), "bridge builds the sandbox env for driver turns");
ok(/spawn\(sbErr \? "\/usr\/bin\/false" : claudeBin/.test(bridge), "bridge refuses (spawns nothing) when the sandbox can't be built");
ok(/env: sb \? sb\.env : env/.test(bridge), "bridge gives the driver's claude the sandbox env");
ok(/command: HOOK_CMD/.test(bridge), "bridge registers the same HOOK_CMD the wrapper passes through");
ok(/"sandbox\.mjs", "sandbox\/driver\.sb", "sandbox\/bashwrap\.sh"/.test(bridge), "bridge self-restart watches the sandbox files");

clean(); fs.rmSync(room, { recursive: true, force: true }); try { fs.rmSync(sb.scratch, { recursive: true, force: true }); } catch {}
console.log(`\n${pass}/${pass + fail} passed.`); process.exit(fail ? 1 : 0);
