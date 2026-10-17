#!/usr/bin/env python3
# Build the host bundle served at /dl/jam.tgz: an explicit ALLOWLIST of the files a bridge needs, nothing else (never
# .jam-key, .env, logs, sessions, qa_* or plists). Deterministic (fixed mtime/owner, gzip mtime 0), so rebuilding
# without code changes produces identical bytes and an unchanged TGZ_BUILD.
import io, os, sys, tarfile, gzip, hashlib
FILES = ["bridge.mjs", "approve-hook.mjs", "route.mjs", "catalog.mjs", "tune-router.mjs", "schedule.mjs", "sandbox.mjs", "termcmd.py", "marathon.mjs",
         "budget.mjs", "turntext.mjs", "turn-events.mjs", "turn-policy.mjs", "models.mjs", "session-store.mjs", "compaction.mjs",
         "room-dispatch.mjs", "uploads.mjs", "schedule-cli.mjs", "jam-url.mjs", "browser.mjs", "claim.mjs", "run.sh", "package.json", "LICENSE", "HOST.md",
         "sandbox/bashwrap.sh", "sandbox/driver.sb"]
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as t:
    for f in FILES:
        data = open(f, "rb").read()
        ti = tarfile.TarInfo("jam/" + f); ti.size = len(data); ti.mtime = 0; ti.uid = ti.gid = 0; ti.uname = ti.gname = ""
        ti.mode = 0o755 if os.access(f, os.X_OK) else 0o644
        t.addfile(ti, io.BytesIO(data))
raw = buf.getvalue()
out = io.BytesIO()
with gzip.GzipFile(fileobj=out, mode="wb", mtime=0, compresslevel=9) as g: g.write(raw)
open(sys.argv[1], "wb").write(out.getvalue())
print(hashlib.sha256(raw).hexdigest()[:10])
