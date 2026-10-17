// Gate for the public host bundle (/dl/jam.tgz, built by mktgz.py via build.sh): run from check.sh after ./build.sh.
import { readFileSync, mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os"; import path from "node:path";
let fail = 0; const ok = (c, m) => { if (!c) { fail++; console.error("  ✗ " + m); } };
const allow = [...readFileSync("mktgz.py", "utf8").match(/FILES = \[([\s\S]*?)\]/)[1].matchAll(/"([^"]+)"/g)].map(m => "jam/" + m[1]).sort();
const listed = execFileSync("tar", ["tzf", "jam.tgz"], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
ok(JSON.stringify(listed) === JSON.stringify(allow), "tarball contents == mktgz.py allowlist (got " + listed.join(",") + ")");
for (const f of listed) ok(!/(\.jam-key|\.env|\.log$|logs\/|sessions|qa_|\.plist$|\.png$|node_modules)/.test(f), "no secret/state file: " + f);
const dir = mkdtempSync(path.join(os.tmpdir(), "jamtgz-"));
try {
  execFileSync("tar", ["xzf", "jam.tgz", "-C", dir]);
  const root = path.join(dir, "jam"); const files = listed.map(f => path.join(dir, f));
  for (const f of files) if (f.endsWith(".mjs")) {
    try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); } catch { ok(false, "syntax: " + f); }
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/from\s+["'](\.\.?\/[^"']+)["']/g)) { const t = path.resolve(path.dirname(f), m[1]); ok(listed.includes("jam/" + path.relative(root, t)), `${path.basename(f)} imports ${m[1]}, which is not in the bundle`); }
  }
  for (const f of ["run.sh", "claim.mjs", "sandbox/bashwrap.sh"]) ok(statSync(path.join(root, f)).mode & 0o100, f + " is executable in the bundle");
  const buf = readFileSync(path.join(dir, "..", path.basename(dir), "jam", "bridge.mjs"), "utf8"); ok(!/jamo_[a-z0-9]{3,20}_[a-z0-9]{20,}/.test(buf), "no host key literal in bridge.mjs");
  for (const f of files) { const t = readFileSync(f, "utf8"); ok(!/[0-9a-f]{48}/.test(t.replace(/sha256[^\n]*/g, "")), "no 48-hex owner-key-shaped string in " + path.basename(f)); }
} finally { rmSync(dir, { recursive: true, force: true }); }
if (fail) { console.error(`tgz.test: ${fail} failure(s)`); process.exit(1); }
console.log(`tgz.test: bundle OK (${listed.length} files)`);
