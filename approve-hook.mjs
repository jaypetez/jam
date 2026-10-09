#!/usr/bin/env node
// jam approval hook (Claude Code PreToolUse). Owners run unimpeded. For everyone else, risky tool calls
// are posted to the room and this hook waits for an owner to Allow or Deny. Exit 0 = allow, exit 2 = block.
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
const env = process.env;
// Which scheme the hub speaks: the same rule as jam-url.mjs (JAM_SCHEME wins; a loopback host is plain http; everything else TLS). Deliberately
// INLINED rather than imported: this hook is the security gate and stays a single self-contained file, so no second file becomes part of its trust
// base (a driver who could edit an imported helper could point approvals at a server that always says Allow). jam-url.test.mjs asserts the two stay identical.
const httpBase = host => { const s = String(env.JAM_SCHEME || "").toLowerCase(); const tls = s === "http" ? false : s === "https" ? true : !/^(?:127(?:\.\d{1,3}){3}|localhost|\[?::1\]?)(?::\d+)?$/i.test(String(host || "")); return (tls ? "https" : "http") + "://" + host; };
const SELF_PATH = fileURLToPath(import.meta.url); // this file — must never be driver-writable, wherever JAM_CWD points
const read = () => new Promise(res => { let s = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", d => s += d); process.stdin.on("end", () => res(s)); });

// Owner-credential / control-file touches. These stay gated even in a room where the owner turned on "run commands on this machine":
// that switch trusts drivers to run commands, not to rewrite the files that decide who is trusted.
const CONTROL_BASH = [
  // Jam control state: schedules and queues are replayed with elevated roles, and .jam-key is the owner credential.
  // A driver rewriting these via Bash would be a privilege escalation, so any mention needs owner approval.
  /scheduled\.json|queue-[\w.-]*\.json|\.jam-key|(?:^|[\s"'=:~/])\.jam(?:\/|\s|$|["'])/,
  // Shell redirects/tee/cp/mv/ln into shell rc files, credentials or the sandbox's own control files (the Edit/Write
  // tools already refuse these via isSensitive; a Bash redirect must not be a way around that).
  /(?:>|\btee\b|\bcp\b|\bmv\b|\bln\b|\bdd\b|\bsed\b[^|;&\n]*(?:\s-\w*i|--in-place)|\btouch\b|\binstall\b|\brsync\b)[^|;&\n]*(?:\.zshrc|\.zshenv|\.zlogin|\.zprofile|\.bashrc|\.bash_profile|\.profile|\.gitconfig|\.npmrc|\.netrc|\.ssh\b|\.aws\b|\.config\b|\.claude\b|LaunchAgents|LaunchDaemons|authorized_keys|approve-hook|bridge\.mjs|nightly\.sh|check\.sh|run-tests\.sh|test-sandbox|\/etc\/)/i,
  // Globbed/env routes to the owner credentials
  /\.jam-k|\.\[j\]am|\.j[\w-]*[*?\[]|(?:sched|queue)[\w.-]*[*?\[]|\bprintenv\b|\$\{?JAM_KEY|\benv\b\s*(?:$|\||;)/,
];

const RISKY_BASH = [
  // Destructive fs: rm with -r/-f, rm -rf, etc. Never safe to do without review.
  /\brm\s+(-[a-z]*[rf][a-z]*\s+|--recursive|--force)/i,
  // Dangerous git: push, force reset, deleting branches, rebase (can lose history)
  /\bgit\s+(push|reset\s+--hard|clean|branch\s+-D|checkout\s+--\s|restore\s|stash\s+drop|rebase)/i,
  // Privilege escalation: sudo/doas always risky
  /\b(sudo|doas)\b/,
  // Process/system control: killall/launchctl/systemctl can break the environment; allow targeted kill/pkill
  /\b(killall|launchctl|systemctl|service)\b/,
  // Permission changes: can lock users out of critical files
  /\b(chmod|chown|chgrp)\b/,
  // Disk operations: mkfs/diskutil/dd can destroy data
  /\b(mkfs|diskutil|dd)\b/,
  // Mutating HTTP to external APIs: only PUT/POST/DELETE/PATCH, not GET (read-only safe)
  /\b(curl|wget)\s+[^|]*\s-X\s*(PUT|POST|DELETE|PATCH)/i,
  // All curl/wget without explicit -X GET: could be mutating or metadata access
  /\b(curl|wget)\b(?!.*\s-X\s*(GET|HEAD))/i,
  // Wrangler deploy/secrets: affects production
  /\bwrangler\s+(deploy|publish|delete|secret)/i,
  // npm publish: affects npm registry
  /\bnpm\s+(publish|unpublish)/i,
  // GitHub releases/merges: affects repository state
  /\bgh\s+(pr|repo|release|api)\s+(create|delete|merge|edit)/i,
  // Database mutations: drop/delete/truncate lose data
  /\bdrop\s+(table|database|schema)/i, /\bdelete\s+from\b/i, /\btruncate\b/i,
  // Package managers: install/remove could break environment
  /\b(brew|apt|apt-get|yum|dnf|pacman)\s+(install|uninstall|remove|upgrade)/i,
  // Write to system dirs: could break OS
  />\s*\/(etc|usr|bin|sbin|var|System|Library)\b/,
  // Cron: persistent background jobs can escape the session
  /\bcrontab\b/,
  // GUI app launch: unpredictable side effects
  /\bopen\s+-a\b/i,
  // Credentials/security: keychain, SSH key generation, auth tokens
  /\b(security|keychain|ssh-keygen)\b/i,
  // Code execution: eval, piping to shells, one-liners with -c/-e can inject arbitrary code
  /\beval\b/, /\b(sh|bash|zsh)\s+-c\b/, /\|\s*(sh|bash|zsh)\b/,
  // Any interpreter invocation is risky — bare, flagged, or "just running a script": a driver-authored script
  // file is exactly as arbitrary as -c/-e, and a trailing "&& whoami" after "interp file.ext" must not exempt it.
  // (Previously this exempted "interp script.ext" when it was the *entire* command, which a trailing "; cmd" or
  // "&& cmd" defeated — chained-command RCE is exactly what the sandbox exists to stop. No longer exempted.)
  /\b(python3?|ruby|perl|php|tclsh|gawk|awk|node|deno|lua|Rscript|julia|erl|escript)\b/i,
  // Symlink creation: lets a driver plant a link inside JAM_CWD pointing outside it, defeating cwd confinement
  // on a later Read/Grep/cat of the link (isInsideWorkdir only string-prefixes the requested path).
  /\bln\s+-\w*s/i,
  // find -exec / -ok run an arbitrary command per matched file — including files found outside cwd via `find /`;
  // xargs does the same from piped input. Both bypass the literal-path readsOutside heuristic below (no literal
  // "/path" token follows the reader command when it's `{}` from find or an xargs-supplied arg).
  /\bfind\b.*(-exec|-ok)\b/i,
  /\bxargs\b/i,
  // Binary encoding/decoding: often used to hide code injection
  /\bbase64\s+(-d|--decode)/i, /\bxxd\s+-r/,
  // Executable creation: chmod +x makes scripts executable (review source first)
  /\bchmod\s+\+x\b/,
  // Script execution: verify the script source before running local shell/python/node scripts
  // (\b never matches before a leading "." — this rule was dead for ./x.sh at the start of a segment until 2026-09-29.)
  /(?:^|[\s;&|(])\.\/[\w.-]+\.(sh|py|mjs|js|pl|rb)\b/,
  // Shell launchers that run a script/string: bash x.sh, sh -c, source x, . x, $SHELL
  /(?:^|[\s;&|(])(?:bash|sh|zsh|dash|ksh|source|eval|exec)\s+\S|(?:^|[;&|(]\s*)\.\s+\S|\$\{?SHELL\b/,
  // Background process escape: nohup lets a process outlive the session
  /\bnohup\b/,
  // Batch delete: xargs rm can destroy many files at once
  /\bxargs\s+rm\b/,
  ...CONTROL_BASH,
  // Find delete: -delete flag removes files without review
  /\bfind\b.*-delete/,
  // Git config: can change identity, push remotes, security settings
  /\bgit\s+config\b/,
  // Env isolation: env -i strips environment, can cause scripts to fail unpredictably
  /\benv\s+-i\b/,
  // Osascript/applescript: GUI automation, screen recording, clipboard access
  /\bosascript\b/i,
  // Netcat: arbitrary network listening/connections
  /\bnetcat\b|\bnc\s+-l/i,
  // Heredoc/here-string writes: can inject code into files
  /<<[-<]?\s*['"]?EOF|<<[-<]?\s*'[^']*'/i,
  // Process substitution: <(...) or >(...) can be used for RCE
  /[<>]\(/,
  // Command substitution with backticks or $(): nested code execution
  /`[^`]+`|\$\([^)]+\)/,
];

function classify(tool, input) {
  const cwd = env.JAM_CWD || process.cwd();

  // Resolve a path the same way the filesystem will: normalize ".." lexically, then realpath through any
  // symlinks (a driver can `ln -s ~ $JAM_CWD/pwn` — see the RISKY_BASH `ln -s` rule above — and a naive
  // string-prefix check would happily call the link "inside" the workdir). If the path doesn't exist yet
  // (e.g. Write creating a new file), walk up to the nearest existing ancestor and realpath that instead,
  // so a symlinked *parent* directory still resolves correctly.
  const resolveReal = (fp) => {
    const abs = path.resolve(cwd, String(fp || "").replace(/^~(?=\/|$)/, os.homedir())); // file tools may expand a leading ~ themselves
    let dir = abs, tail = "";
    while (true) {
      try { return path.join(fs.realpathSync(dir), tail); }
      catch {
        const parent = path.dirname(dir);
        if (parent === dir) return abs; // hit filesystem root without finding an existing ancestor
        tail = path.join(path.basename(dir), tail);
        dir = parent;
      }
    }
  };
  let cwdReal; try { cwdReal = fs.realpathSync(cwd); } catch { cwdReal = path.resolve(cwd); }
  const selfReal = (() => { try { return fs.realpathSync(SELF_PATH); } catch { return SELF_PATH; } })();

  // realpathSync canonicalizes case on macOS's default case-insensitive-but-preserving APFS volume, so this
  // comparison is correct on both case-sensitive and case-insensitive filesystems without manual lower-casing.
  // Windows (2026-10-09 review): realpath returns backslash paths, so every "/" prefix and (^|\/) pattern below never matched and
  // inside-workdir was never true. Normalise to "/" there; a no-op on POSIX, where a backslash is an ordinary filename character.
  const fwd = (p) => path.sep === "\\" ? String(p).replace(/\\/g, "/") : String(p);
  const isInsideWorkdir = (fp) => {
    if (!fp) return false;
    const real = fwd(resolveReal(fp)), cw = fwd(cwdReal);
    const prefix = cw.replace(/\/$/, "") + "/";
    return real === cw || real.startsWith(prefix);
  };
  // Case-insensitive (`i` flag): a case-sensitive blocklist is trivially evaded on macOS's default
  // case-insensitive APFS volume, e.g. Read "/Users/mike/.SSH/ID_RSA" resolves to the same file as
  // "~/.ssh/id_rsa" on disk but wouldn't match a case-sensitive pattern for "id_rsa"/".ssh".
  // Also protects the hook's own source (SELF_PATH, matched separately below) is not enough on its own —
  // this list additionally names bridge.mjs and the .jam state dir so a driver whose JAM_CWD happens to be
  // (or contain) the jam repo can't disarm the sandbox by editing its control files.
  const SENSITIVE_RE = /(^|\/)(\.env|\.jam-key|\.ssh|\.aws|\.config|Library|\.claude(\/|$)|\.zshrc|\.bashrc|\.profile|\.gitconfig|id_rsa|\.npmrc|\.git(\/|$)|approve-hook\.mjs|bridge\.mjs|nightly\.sh|check\.sh|run-tests\.sh|test-sandbox\.mjs|\.jam(\/|$))/i;
  const isSensitive = (fp) => {
    const real = resolveReal(fp);
    if (real === selfReal) return true; // the hook can never be self-writable, full stop
    return SENSITIVE_RE.test(fwd(real)) || SENSITIVE_RE.test(fwd(fp || "")); // tested on both the resolved and the literal path
  };

  // Files the owner's next claude/git/editor run would load with owner rights. The Bash profile denies these; this covers the in-process
  // Write/Edit tools (the profile can't reach them).
  const isPlant = (fp) => /(^|\/)(\.claude[^/]*|CLAUDE[^/]*\.md|\.mcp\.json|\.envrc|\.gitmodules|\.gitattributes|\.vscode)(\/|$)/i.test(fwd(resolveReal(fp)));
  // Default-deny: all tools except Owner calls are risky unless explicitly allowed below
  if (tool === "Bash") {
    const c = String(input.command || "");

    // Check standard risky patterns first
    const hit = RISKY_BASH.find(re => re.test(c));
    if (hit) return { risky: true, summary: c };

    // Cwd confinement for drivers: if not owner, bash must either:
    // (a) be a simple read command that doesn't navigate, OR
    // (b) start with 'cd $JAM_CWD && ...' to explicitly restrict scope
    if (env.JAM_FROM_ROLE !== "owner") {
      const hasExplicitCwd = c.includes("$JAM_CWD") || c.includes(`${cwd}`);
      // `cd` is fine when its target resolves inside the room (relative targets included); `cd ..` / `cd /x` / `cd ~` are not
      const navigates = [...c.matchAll(/\bcd\s+(?:--\s+)?("[^"]*"|'[^']*'|[^\s;&|]+)/gi)].some(m => {
        const t = m[1].replace(/^["']|["']$/g, "").replace(/\$\{?JAM_CWD\}?/g, cwd);
        return !t || /[`$]/.test(t) || !isInsideWorkdir(path.resolve(cwd, t.replace(/^~(?=\/|$)/, os.homedir())));
      });
      const readsOutside = /(?:^|\s)(cat|head|tail|less|more|grep|sed|awk)\s+[/~]/.test(c);

      if (navigates || (readsOutside && !hasExplicitCwd)) {
        return { risky: true, summary: c };
      }
    }

    return { risky: false };
  }

  if (tool === "Read" || tool === "Grep") {
    // Read/Grep: only safe if reading inside workdir and not sensitive files
    const fp = tool === "Read" ? String(input.file_path || "") : String(input.path || "");
    if (!isInsideWorkdir(fp) || isSensitive(fp)) {
      return { risky: true, summary: `${tool} ${fp}` };
    }
    return { risky: false };
  }

  if (tool === "Glob") {
    // Glob: only safe if glob is inside workdir
    const pattern = String(input.pattern || "");
    if (!isInsideWorkdir(pattern) || (input.path && (!isInsideWorkdir(String(input.path)) || isSensitive(String(input.path))))) { // `path` is the directory actually listed
      return { risky: true, summary: `Glob ${pattern} in ${input.path || "."}` };
    }
    return { risky: false };
  }

  if (tool === "WebFetch") {
    // WebFetch: only safe if reading from https (not http) and not internal/metadata APIs
    const url = String(input.url || "");
    let u = null; try { u = new URL(url); } catch {}
    // WHATWG parsing normalizes 127.1 / 0x7f.1 / decimal forms to dotted quads, so IP literals, single-label and *.local/.internal
    // hosts (LAN, localhost, cloud metadata) are all caught structurally instead of by a prefix regex.
    const h = u ? u.hostname.toLowerCase() : "";
    const internal = !u || u.protocol !== "https:" || u.username || u.password || !h.includes(".") || h.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(h) || /\.(local|localhost|internal|lan|home|corp)$/.test(h);
    if (internal) {
      return { risky: true, summary: `WebFetch ${url.slice(0, 100)}` };
    }
    return { risky: false };
  }

  if (tool === "Write" || tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") {
    const fp = String(input.file_path || input.notebook_path || "");
    if (isInsideWorkdir(fp) && !isSensitive(fp) && isPlant(fp)) {
      return { risky: true, summary: `⚠ CONFIG PLANT — ${tool} ${fp} (a file claude/git/your editor load with YOUR rights on a later run)` };
    }
    if (!isInsideWorkdir(fp) || isSensitive(fp)) {
      return { risky: true, summary: `${tool} ${fp}` };
    }
    return { risky: false };
  }

  // Default-deny: any tool not named above is risky unless it is known-inert. A driver reaching an MCP tool would act as the
  // owner's own accounts (Gmail send, Drive, ...), and CronCreate/RemoteTrigger/Workflow/Monitor persist or run code, so these
  // need owner approval. New tools land here automatically.
  if (INERT_TOOLS.has(tool)) return { risky: false };
  return { risky: true, summary: `${tool} ${JSON.stringify(input).slice(0, 200)}` };
}
// Commands a driver can never run, Allow card or not, "run commands on this machine" or not. This list is NOT a boundary (shell can
// always be spelled another way); the Seatbelt profile is the real fence (writes and reads confined to the room, no signals to other
// processes, process cap). The list refuses the obvious intent up front with a clear reason instead of a card to judge. Deleting files and folders inside the room is normal development
// and stays allowed; wiping the room itself, or anything outside it, is not.
// A command word in command position (segment start, after env assignments / exec / command / env / time, optionally by full path),
// so "grep sudo ." or "echo at noon" don't trip it.
const cmdAt = words => new RegExp(String.raw`(?:^|[;&|({\n]|\b(?:then|do|else)\s)\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:(?:exec|command|builtin|env|time|nice|xargs|\/usr\/bin\/env)\s+(?:-\S+\s+)*)*\\?(?:\/(?:usr\/)?s?bin\/)?(?:${words})(?=$|[\s;&|)])`);
const HARMFUL_BASH = [
  [/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:|\b(\w+)\s*\(\s*\)\s*\{[^}]*\b\1\s*\|\s*\1\s*&/, "a fork bomb"],
  [cmdAt("sudo|doas|su|launchctl|crontab|at|osascript|shutdown|reboot|halt|pmset|nvram|csrutil|systemsetup|kextload|kmutil|spctl|fdesetup|dscl|sysadminctl|passwd|mkfs(?:\\.\\w+)?|newfs\\w*|diskutil|tmutil|scutil|networksetup"), "system administration, privilege or scheduling commands"],
  [/\bdd\b[^;&|\n]*\bof=\s*\/dev\//, "writing raw devices"],
  [cmdAt("nohup|disown|setsid|screen|tmux"), "processes that outlive the turn"],
  [/\/dev\/(?:tcp|udp)\/|\b(?:nc|ncat|netcat)\b[^;&|\n]*\s-[a-z]*[ec]\b|\bsocat\b[^;&|\n]*\b(?:exec|system):|\b(?:ba|z|k|da)?sh\s+-i\b[^;|\n]*>&/, "a remote shell"],
  [/\b(?:curl|wget)\b[^;&\n]*\|\s*(?:sudo\s+)?(?:env\s+)?(?:(?:ba|z|k|da)?sh|python3?|perl|ruby|node)\b|<\(\s*(?:curl|wget)\b/, "running a download straight from the network"],
];
// rm/rmdir/unlink targets: the room itself (".", "*", "$PWD", its absolute path) or anything above or outside it.
function harmfulRm(cmd, cwd, scratch) {
  const home = os.homedir();
  const real = p => { let d = p, tail = ""; for (;;) { try { return path.join(fs.realpathSync(d), tail); } catch { const up = path.dirname(d); if (up === d) return p; tail = path.join(path.basename(d), tail); d = up; } } }; // nearest existing ancestor
  const room = real(cwd), allowed = [room, scratch && real(scratch)].filter(Boolean);
  const inside = (p, d) => p.startsWith(d.replace(/\/$/, "") + "/");
  for (const m of String(cmd).matchAll(/(?:^|[;&|(\n]|\b(?:then|do|else|xargs)\s)\s*(?:command\s+|builtin\s+|\\)?(?:\/bin\/)?(rm|rmdir|unlink)\s+([^;&|\n]*)/g)) {
    let opts = true;
    for (const raw of m[2].match(/"[^"]*"|'[^']*'|\S+/g) || []) {
      const t = raw.replace(/^["']|["']$/g, "");
      if (opts && t === "--") { opts = false; continue; }
      if (opts && /^-/.test(t)) continue;
      if (/^[<>]|^\d?>/.test(t)) break; // redirect
      let x = t.replace(/^~(?=\/|$)/, home).replace(/\$\{?HOME\}?/g, home).replace(/\$\{?(?:PWD|JAM_CWD)\}?/g, cwd);
      if (/[`$]/.test(x)) continue; // unexpandable here; the sandbox still confines it
      const globRoot = /^(?:\.\/)?(?:\*|\.\*|\.\[!\.\]\*|\*\.\*)$/.test(x); // "*", "./*", ".*", "*.*": everything in the room ("*.log" is fine)
      x = x.replace(/\/(?:\.?\*|\*\.\*)$/, "") || "/"; // "dir/*" wipes dir
      const abs = real(path.resolve(cwd, x));
      if (globRoot || abs === room) return `deleting the room's whole directory (${t})`;
      if (!allowed.some(d => inside(abs, d))) return `deleting outside the room (${t})`;
    }
  }
  return null;
}
function harmfulBash(cmd, cwd, scratch) {
  const c = String(cmd || "");
  const hit = HARMFUL_BASH.find(([re]) => re.test(c));
  return hit ? hit[1] : harmfulRm(c, cwd, scratch);
}
const GIT_WRITE = /(?:^|[\s;&|(])git\s+(?:-[^\s]+\s+(?:\S+\s+)?)*(?:commit|add|rm|mv|reset|checkout|switch|restore|merge|rebase|stash(?!\s+(?:list|show)\b)|tag(?!\s+(?:-l\b|--list\b|$))|cherry-pick|revert|am|apply|clean|gc|config(?=\s+(?:--(?:add|unset|replace-all|edit|global|system|local|worktree|file)\b|-e\b|[^\s-]\S*\s+[^\s-]))|submodule|worktree|update-index|update-ref|symbolic-ref|init)\b/;
const INERT_TOOLS = new Set(["WebSearch", "ToolSearch", "TodoWrite", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TaskOutput", "BashOutput", "AskUserQuestion", "ExitPlanMode", "EnterPlanMode"]);

// The scheduler role (turns the host queued from ~/.jam/scheduled.json) is NOT blanket-trusted: a driver's Bash can
// write that file, so "scheduler" is only as trustworthy as the narrowest thing we let it do. It gets an allowlist
// for the nightly gate's own command shapes; anything else falls through to the normal gated (driver) flow.
// Without this the 9am nightly hit the driver cwd rules ("cd ~/...", "cat /tmp/...") and died on the 10-min timeout.
const NIGHTLY_OUT = String.raw`/tmp/nightly[\w.-]*\.out`;
const JAM_DIR = (() => { try { return fs.realpathSync(path.dirname(SELF_PATH)); } catch { return path.dirname(SELF_PATH); } })();
const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The scheduler runs ./nightly.sh with the hook off for that call, so the script's bytes are pinned: the sha256 lives in
// ~/.jam/nightly.sha256 (Bash/Edit/Write on ~/.jam are gated for drivers). A driver who rewrites nightly.sh, or the cwd
// it runs from, no longer matches, and the call falls through to the normal gated flow. After a legitimate edit, the
// owner re-pins: `shasum -a 256 nightly.sh | cut -d' ' -f1 > ~/.jam/nightly.sha256`.
const nightlyPinned = () => {
  try {
    const want = fs.readFileSync(path.join(env.HOME || os.homedir(), ".jam", "nightly.sha256"), "utf8").trim();
    const got = crypto.createHash("sha256").update(fs.readFileSync(path.join(JAM_DIR, "nightly.sh"))).digest("hex");
    return /^[0-9a-f]{64}$/.test(want) && want === got;
  } catch { return false; }
};
const SCHED_SEGMENTS = [
  new RegExp(String.raw`^cd\s+(?:~|\$HOME|${esc(os.homedir())})\/claude\/jam$`),
  new RegExp(String.raw`^cd\s+${esc(JAM_DIR)}$`),
  new RegExp(String.raw`^\.\/nightly\.sh(?:\s+>\s*${NIGHTLY_OUT})?(?:\s+2>&1)?$`),
  /^rc=\$\?$/,
  new RegExp(String.raw`^echo\s+"EXIT=\$(?:\?|rc)"(?:\s+>>\s*${NIGHTLY_OUT})?$`),
  new RegExp(String.raw`^(?:cat|tail|head)(?:\s+-n\s+\d+)?\s+${NIGHTLY_OUT}$`),
  /^sleep\s+\d{1,3}$/,
];
function schedulerAllowed(tool, input) {
  if (tool === "Read") return new RegExp(`^${NIGHTLY_OUT}$`).test(String(input.file_path || ""));
  if (tool !== "Bash") return false;
  const c = String(input.command || "").trim();
  if (!c || /[|`<\r]|\$\(|\|\|/.test(c)) return false;
  const segs = c.split(/\s*(?:&&|;|\n)\s*/).filter(Boolean);
  if (!segs.every(seg => SCHED_SEGMENTS.some(re => re.test(seg)))) return false;
  if (segs.some(seg => seg.startsWith("./nightly.sh"))) { // it must run from the jam dir, and the script must be the pinned one
    let cwdOk = false; try { cwdOk = fs.realpathSync(env.JAM_CWD || process.cwd()) === fs.realpathSync(JAM_DIR); } catch {}
    const cdOk = segs.some(seg => /^cd\s/.test(seg));
    if (!(cwdOk || cdOk) || !nightlyPinned()) return false;
  }
  return true;
}
export { classify, RISKY_BASH, schedulerAllowed, harmfulBash };

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Only run the approval flow when this file is executed directly (as the PreToolUse hook). When imported by a
// test file it must NOT read stdin or call process.exit — that's what forced test-sandbox.mjs to keep a
// hand-copied duplicate of classify()/RISKY_BASH, which is how the Read/Grep/Glob/WebFetch matcher-wiring gap
// (see bridge.mjs) went undetected: the duplicate "passed" while the real dispatch path was never exercised.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH;
if (isMain) (async () => {
  // Claude Code treats any exit other than 2 as a NON-blocking error and runs the tool, so a crash here would fail open.
  process.on("uncaughtException", e => { console.error("jam: approval hook crashed; blocked:", e && e.message); process.exit(2); });
  process.on("unhandledRejection", e => { console.error("jam: approval hook crashed; blocked:", e && e.message); process.exit(2); });
  let payload = {}; try { payload = JSON.parse(await read()); } catch {}
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) payload = {};
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const input = payload.tool_input && typeof payload.tool_input === "object" && !Array.isArray(payload.tool_input) ? payload.tool_input : {};
  const badShape = payload.tool_input !== undefined && input !== payload.tool_input; // e.g. tool_input as a string
  if (tool === "Agent") { // background subagents lose their report when the turn ends and stream their tool calls into the room after Claude's closing message
    if (input.run_in_background !== false) { /* unset means background in this CLI — require an explicit false */ console.error("Blocked: subagents must run in the foreground in a jam turn (run_in_background: false). A background subagent's report is lost when this turn ends, and its tool calls bury your closing message. Re-run the same Agent call with run_in_background: false and wait for it."); process.exit(2); }
    process.exit(0);
  }
  if (env.JAM_FROM_ROLE === "owner" || (env.JAM_FROM_ROLE === "scheduler" && schedulerAllowed(tool, input)) ) process.exit(0);
  // Driver turns can't write the room's .git (the sandbox denies it), so a commit/add/etc. is certain to fail — say so up front
  // instead of raising an Allow card for the owner and then failing after they approve it (found by olga-qa).
  if (env.JAM_FROM_ROLE === "driver" && tool === "Bash" && GIT_WRITE.test(String(input.command || ""))) {
    console.error("Blocked: changing git state (commit, add, checkout, merge, reset, ...) is owner-only in a jam room; drivers can read history (status, diff, log) but not write it. Leave the changes in the working tree and tell the owner what to commit."); process.exit(2);
  }
  if (env.JAM_FROM_ROLE === "driver" && tool === "Bash") {
    const why = harmfulBash(input.command, env.JAM_CWD || process.cwd(), env.JAM_SB_SCRATCH);
    if (why) { console.error(`Blocked: drivers can't run ${why} in a jam room. Work inside the room's folder (deleting individual files and folders there is fine) and continue with the rest of the task.`); process.exit(2); }
  }
  // Owner switched on "Run commands on this machine" for this room: a driver's Bash runs without an Allow card (the Seatbelt
  // sandbox still applies). Only the bridge sets JAM_RUN_LOCAL, and only for driver turns of a room whose flag is true. File tools,
  // MCP and every other tool stay gated; so do control-file touches (CONTROL_BASH).
  if (env.JAM_FROM_ROLE === "driver" && env.JAM_RUN_LOCAL === "1" && tool === "Bash" && !badShape && !input.dangerouslyDisableSandbox && !CONTROL_BASH.some(re => re.test(String(input.command || "")))) process.exit(0);
  const c = badShape ? { risky: true, summary: `${tool} with a malformed tool_input` } : classify(tool, input); if (!c.risky) process.exit(0);
  // Every bridge turn has these set; missing them means the hook is running somewhere it can't reach the room to ask.
  // A risky call must not slip through then (it used to exit 0 here, i.e. fail open).
  // Driver turns don't carry the hub key in their environment (a same-uid process can read another's env); the hook runs outside the
  // sandbox, so it reads the key from disk instead.
  let hubKey = env.JAM_KEY || ""; if (!hubKey) { try { hubKey = fs.readFileSync(path.join(JAM_DIR, ".jam-key"), "utf8").trim(); } catch {} }
  if (!env.JAM_HOST || !hubKey || !env.JAM_ROOM) { console.error("jam: no room to ask for approval (JAM_HOST/JAM_KEY/JAM_ROOM unset); blocked"); process.exit(2); }

  const base = `${httpBase(env.JAM_HOST)}/api/approve`; const q = `?k=${encodeURIComponent(hubKey)}&room=${encodeURIComponent(env.JAM_ROOM)}`;
  let id;
  try {
    const r = await fetch(base + q, { method: "POST", body: JSON.stringify({ from: env.JAM_FROM || "?", tool, summary: c.summary.slice(0, 2000), detail: JSON.stringify(input).slice(0, 6000) }) });
    id = (await r.json()).id;
  } catch (e) { console.error(`jam: could not reach the room for approval (${e.message}); blocked`); process.exit(2); }
  if (!id) { console.error("jam: approval request failed; blocked"); process.exit(2); }

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/${id}${q}`); const j = await r.json();
      if (j.state === "allowed") process.exit(0);
      if (j.state === "denied") { console.error(`Blocked: ${j.by || "the owner"} denied this ${tool} call in the jam room. Ask them in the room if it's needed, and continue with the rest of the task.`); process.exit(2); }
    } catch { /* transient: retry after the sleep below */ }
    await sleep(1500); // was only in the catch, so a pending approval polled the worker in a tight loop for up to 10 minutes
  }
  console.error("Blocked: no owner approved this call within 10 minutes. Continue with the rest of the task without it."); process.exit(2);
})();
