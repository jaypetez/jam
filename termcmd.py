#!/usr/bin/env python3
"""Run one terminal-only Claude Code slash command (/doctor, /color …) in a throwaway interactive session.

  termcmd.py <cwd> <command text> -- <claude binary> [args…]   → prints the final screen as plain text, exit 0
  termcmd.py --selftest                                         → checks the screen emulator

Opens a real pty (120×50), waits for the prompt, types the command, waits for the output to settle, snapshots the
screen, then exits the session (Esc, Ctrl-C ×2, then SIGTERM/SIGKILL). Headless `claude -p` lists these commands in
init.terminal_slash_commands but can't run them; this is the "open a terminal, run it, close it" path for jam.
"""
import os, pty, re, select, signal, struct, sys, time, fcntl, termios

COLS, ROWS = 120, 50

class Screen:
    """Just enough VT100 to replay Ink's redraws: cursor moves, erase line/screen, scroll. Colors and modes are ignored."""
    def __init__(self, cols=COLS, rows=ROWS):
        self.cols, self.rows = cols, rows; self.g = [[" "] * cols for _ in range(rows)]; self.r = self.c = 0; self.pend = ""
    def _scroll(self): self.g.pop(0); self.g.append([" "] * self.cols)
    def _clamp(self): self.r = max(0, min(self.rows - 1, self.r)); self.c = max(0, min(self.cols - 1, self.c))
    def feed(self, s):
        s = self.pend + s; self.pend = ""; i = 0; n = len(s)
        while i < n:
            ch = s[i]
            if ch == "\x1b":
                if i + 1 >= n: self.pend = s[i:]; return
                nx = s[i + 1]
                if nx == "[":
                    m = re.match(r"\x1b\[([?>=]?)([\d;]*)([ -/]*)([@-~])", s[i:])
                    if not m:
                        if n - i < 32: self.pend = s[i:]; return
                        i += 2; continue
                    self._csi(m.group(1), m.group(2), m.group(4)); i += m.end(); continue
                if nx == "]":  # OSC … BEL or ST
                    j = s.find("\x07", i); k = s.find("\x1b\\", i)
                    ends = [e for e in ((j, 1), (k, 2)) if e[0] >= 0]
                    if not ends: self.pend = s[i:]; return
                    e = min(ends); i = e[0] + e[1]; continue
                if nx in "()": i += 3; continue
                i += 2; continue  # ESC 7/8/=/> etc.
            if ch == "\r": self.c = 0
            elif ch == "\n":
                if self.r == self.rows - 1: self._scroll()
                else: self.r += 1
            elif ch == "\b": self.c = max(0, self.c - 1)
            elif ch == "\t": self.c = min(self.cols - 1, (self.c // 8 + 1) * 8)
            elif ch >= " ":
                if self.c >= self.cols:
                    self.c = 0
                    if self.r == self.rows - 1: self._scroll()
                    else: self.r += 1
                self.g[self.r][self.c] = ch; self.c += 1
            i += 1
    def _csi(self, priv, params, final):
        if priv: return  # private modes (?25l, ?2004h …)
        p = [int(x) if x else 0 for x in params.split(";")] if params else []
        a = (p[0] if p else 0) or 1
        if final == "A": self.r -= a
        elif final == "B": self.r += a
        elif final == "C": self.c += a
        elif final == "D": self.c -= a
        elif final == "E": self.r += a; self.c = 0
        elif final == "F": self.r -= a; self.c = 0
        elif final == "G": self.c = a - 1
        elif final == "d": self.r = a - 1
        elif final in "Hf": self.r = (p[0] if p and p[0] else 1) - 1; self.c = (p[1] if len(p) > 1 and p[1] else 1) - 1
        elif final == "K":
            m = p[0] if p else 0; row = self.g[self.r]; c = min(self.c, self.cols)
            rng = range(c, self.cols) if m == 0 else range(0, min(c + 1, self.cols)) if m == 1 else range(self.cols)
            for x in rng: row[x] = " "
        elif final == "J":
            m = p[0] if p else 0
            if m == 0: self._csi("", "0", "K"); rows = range(self.r + 1, self.rows)
            elif m == 1: rows = range(0, self.r)
            else: rows = range(self.rows)
            for y in rows: self.g[y] = [" "] * self.cols
        if final != "K" and final != "J": self._clamp()
    def text(self):
        lines = ["".join(row).rstrip() for row in self.g]
        out, blank = [], 0
        for l in lines:
            blank = blank + 1 if not l else 0
            if blank <= 1: out.append(l)
        return "\n".join(out).strip("\n")

def chrome_off(t):
    """Drop the input box + status footer under the last ──── rule: that's the idle prompt, not the command's output."""
    lines = t.split("\n"); rules = [i for i, l in enumerate(lines) if len(l) > 20 and l.count("\u2500") >= 0.8 * len(l)]
    tail = [i for i in rules if i >= len(lines) - 12]
    return "\n".join(lines[:tail[0]]).rstrip() if tail else t

def selftest():
    s = Screen(20, 4); s.feed("hello\r\nworld"); assert s.text() == "hello\nworld", s.text()
    s.feed("\x1b[1A\x1b[2K\x1b[Gbye"); assert s.text() == "bye\nworld", s.text()
    s.feed("\x1b[2J\x1b[H\x1b[31mred\x1b[0m\x1b]0;title\x07!"); assert s.text() == "red!", s.text()
    s = Screen(10, 2); s.feed("a\r\nb\r\nc"); assert s.text() == "b\nc", s.text()  # scroll
    s = Screen(10, 2); s.feed("\x1b[3"); s.feed("1mX"); assert s.text() == "X", s.text()  # split escape across reads
    assert chrome_off("out\n" + "\u2500" * 30 + "\n\u276f \n" + "\u2500" * 30 + "\n  footer") == "out"
    print("termcmd selftest ok")

def main():
    if sys.argv[1:] == ["--selftest"]: return selftest()
    if "--" not in sys.argv or len(sys.argv) < 5: print(__doc__, file=sys.stderr); sys.exit(2)
    k = sys.argv.index("--"); cwd, cmd, argv = sys.argv[1], " ".join(sys.argv[2:k]), sys.argv[k + 1:]
    cmd = re.sub(r"[\x00-\x1f\x7f]", " ", cmd).strip()  # one line, typed once: no smuggled Enter/escapes
    env = {**os.environ, "TERM": "xterm-256color", "COLUMNS": str(COLS), "LINES": str(ROWS)}
    env.pop("CLAUDECODE", None)
    pid, fd = pty.fork()
    if pid == 0:
        try: os.chdir(cwd); os.execvpe(argv[0], argv, env)
        finally: os._exit(127)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    scr = Screen(); state = {"last": time.time(), "dead": False}

    def kill():
        """Esc, Ctrl-C ×2 (claude's own exit), then SIGTERM/SIGKILL the session's whole process group (pty.fork → setsid)."""
        for k in ("\x1b", "\x03", "\x03"):
            if state["dead"]: break
            try: os.write(fd, k.encode()); pump(0.4)
            except OSError: break
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                if os.waitpid(pid, os.WNOHANG)[0]: break
                os.killpg(pid, sig); time.sleep(0.8)
            except (ChildProcessError, ProcessLookupError, PermissionError): break
        try: os.killpg(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError): pass
        try: os.waitpid(pid, os.WNOHANG)
        except ChildProcessError: pass
    def on_signal(sig, _f):  # jam's Stop (SIGINT) / closeRoom: take the session down with us
        signal.signal(signal.SIGINT, signal.SIG_IGN); signal.signal(signal.SIGTERM, signal.SIG_IGN)
        state["dead"] = True; kill(); sys.exit(130)
    signal.signal(signal.SIGINT, on_signal); signal.signal(signal.SIGTERM, on_signal)

    def pump(secs):
        end = time.time() + secs
        while time.time() < end and not state["dead"]:
            rd, _, _ = select.select([fd], [], [], 0.1)
            if not rd: continue
            try: b = os.read(fd, 65536)
            except OSError: state["dead"] = True; break
            if not b: state["dead"] = True; break
            t = b.decode("utf8", "replace"); state["last"] = time.time()
            if "\x1b[6n" in t: os.write(fd, f"\x1b[{scr.r + 1};{scr.c + 1}R".encode())  # cursor-position query
            if "\x1b[c" in t or "\x1b[0c" in t: os.write(fd, b"\x1b[?62;c")
            scr.feed(t)

    def settle(quiet, cap, first=0.0):
        t0 = time.time(); pump(first)
        while not state["dead"] and time.time() - t0 < cap:
            pump(0.2)
            if time.time() - state["last"] >= quiet: return

    def send(s): os.write(fd, s.encode()); time.sleep(0.15)

    settle(1.5, 25, first=1.0)  # banner + prompt
    if re.search(r"trust (the files in )?this folder|Do you trust", scr.text(), re.I):  # never click through trust for someone
        kill(); print("This folder hasn't been trusted in Claude Code yet. Open `claude` there yourself once, then retry."); sys.exit(3)
    send(cmd); pump(0.5); send("\r")
    settle(2.5, 240, first=1.5)  # agentic commands (/doctor) animate a spinner until they finish
    shot = chrome_off(scr.text())
    print(shot); sys.stdout.flush(); kill()

def _unused():
    for s in ("\x1b", "\x03", "\x03"):
        if state["dead"]: break
        try: send(s); pump(0.4)
        except OSError: break
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            if os.waitpid(pid, os.WNOHANG)[0]: break
            os.kill(pid, sig); time.sleep(0.8)
        except (ChildProcessError, ProcessLookupError): break

if __name__ == "__main__": main()
