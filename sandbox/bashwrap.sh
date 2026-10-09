#!/bin/bash
# CLAUDE_CODE_SHELL_PREFIX target for driver turns: Claude Code runs every Bash-tool command as `<this script> '<command string>'`
# (a zsh/bash snippet: snapshot source, eval, cwd bookkeeping). Only those commands run under the Seatbelt profile; claude itself
# is not wrapped. Params come from the bridge via JAM_SB_* env (sandbox.mjs). Credentials claude holds for itself (the hub key the
# approval hook uses, API keys) are removed from what the driver's shell can see; caches are redirected into the scratch dir
# because ~ is not writable.
set -u
# Claude Code also routes its hook commands through here. The approval hook must run outside the sandbox with its full env.
[ "$1" = "${JAM_SB_HOOK_CMD:-}" ] && exec /bin/bash -c "$1"
# Drop anything credential-shaped from the shell's env: claude keeps what it needs for itself, the driver's commands don't get it.
for v in $(compgen -e); do
  case "$(printf %s "$v" | tr a-z A-Z)" in *TOKEN*|*KEY*|*SECRET*|*PASSWORD*|*CREDENTIAL*|SSH_AUTH_SOCK) unset "$v";; esac
done
# Fork-bomb guard: RLIMIT_NPROC counts every process of this uid, so allow what's running now plus headroom (inherited only by this
# command's tree; the owner's own processes are unaffected). 4 GB per written file. Hard limits: the command can't raise them back.
n=$(/bin/ps -U "$(/usr/bin/id -u)" -o pid= 2>/dev/null | /usr/bin/wc -l); [ "${n:-0}" -gt 0 ] && ulimit -u $((n + 512)) 2>/dev/null
ulimit -f 4194304 2>/dev/null
# TMPDIR is the scratch dir; the owner's own TMPDIR is off limits. Bare `mktemp` ignores $TMPDIR (it asks confstr), and zsh heredocs
# use $TMPPREFIX, so the shell gets a startup file (zsh: $ZDOTDIR/.zshenv, bash: $BASH_ENV) pointing both at the scratch dir.
mkdir -p "$JAM_SB_SCRATCH/tmp" "$JAM_SB_SCRATCH/sh"
cat > "$JAM_SB_SCRATCH/sh/.zshenv" <<'RC'
mktemp() { local a want=1 skip=0; for a in "$@"; do if [ $skip = 1 ]; then skip=0; continue; fi; case "$a" in -p|--tmpdir) skip=1; want=0;; -*t) skip=1;; -*) ;; *) want=0;; esac; done
  if [ $want = 1 ]; then command mktemp -p "${TMPDIR%/}" "$@"; else command mktemp "$@"; fi; }
RC
# Every process this command starts inherits fd 19 on the turn's marker file, so the bridge can find and reap what the turn left
# running (sandbox.mjs reapDriver). A sandboxed process's environment is hidden from `ps -E`, so an env marker wouldn't do.
: >> "$JAM_SB_SCRATCH/.turn"; exec 19<"$JAM_SB_SCRATCH/.turn"
exec env -u CLAUDE_CODE_SHELL_PREFIX -u JAM_SB_HOOK_CMD \
  TMPDIR="$JAM_SB_SCRATCH/tmp/" TMPPREFIX="$JAM_SB_SCRATCH/tmp/zsh" ZDOTDIR="$JAM_SB_SCRATCH/sh" BASH_ENV="$JAM_SB_SCRATCH/sh/.zshenv" XDG_CACHE_HOME="$JAM_SB_SCRATCH/cache" npm_config_cache="$JAM_SB_SCRATCH/npm" \
  /usr/bin/sandbox-exec -f "$JAM_SB_PROFILE" -D "HOME=$JAM_SB_HOME" -D "CWD=$JAM_SB_CWD" -D "SCRATCH=$JAM_SB_SCRATCH" -D "UID=$JAM_SB_UID" \
  "${SHELL:-/bin/zsh}" -c "$1"
