#!/usr/bin/env node
// `npm run e2e`: the live end-to-end suite, run against a LOCAL stack (real Worker on workerd + real bridge + the fake claude) instead of the production
// Worker. It is a cross-platform Node port of run-tests.sh's stages, so the same test files (test.mjs, compact.test.mjs, ...) run unchanged; run-tests.sh
// stays the way to run them against a deployed Worker. Nothing here touches production or the host's ~/.jam.
//
//   npm run e2e                     the whole suite, fake claude
//   npm run e2e -- --only compact   just tests whose file name contains "compact" (repeatable)
//   npm run e2e -- --real           use the host's real claude instead (spends quota; the opt-in smoke)
//   npm run e2e -- --no-browser     skip the Playwright tests (reported SKIPPED, exit 0); without this flag a missing Chromium is a failure
//   npm run e2e -- --keep           keep the throwaway state (logs, Worker storage) afterwards
// Exit 0 only if every test that was selected ran, printed at least one PASS, no FAIL line, and exited 0.
import fs from "node:fs"; import path from "node:path";
import { startStack, runToEnd, ROOT, sleep } from "./stack.mjs";

const args = process.argv.slice(2);
const flag = f => args.includes(f), vals = f => args.flatMap((a, i) => a === f && args[i + 1] ? [args[i + 1]] : []);
const real = flag("--real"), keep = flag("--keep"), noBrowser = flag("--no-browser"), only = vals("--only");
const logDir = path.join(ROOT, "logs", "e2e"); fs.rmSync(logDir, { recursive: true, force: true }); fs.mkdirSync(logDir, { recursive: true });

// ── Chromium: the browser tests need Playwright's browser; a missing one is a failure unless --no-browser says it is deliberate
let browserOk = false;
try { const { chromium } = await import("playwright"); browserOk = fs.existsSync(chromium.executablePath()); } catch {}
if (!browserOk && !noBrowser && !only.length) { console.error("e2e: Playwright's Chromium is not installed. Run `npm run setup:e2e`, or pass --no-browser to skip the browser tests on purpose."); process.exit(1); }

if (real && fs.existsSync(path.join(ROOT, ".jam-key"))) console.log("e2e: NOTE: this repo has a .jam-key. With --real, the approval hook reads it instead of the local stack's key, so driver approval checks will fail; move it aside for this run.");
const MAIN = ["test-e2e", "test-upload", "test-compact", "test-status-bar", "test-statusbar-live", "test-reconnect", "test-qa-boot-feature", "test-cobrowse"];
const STUB = f => path.join(ROOT, f);
// Each stage: the rooms it needs, the bridge to run for them (the live suite runs a different bridge per concern), and the test files that use it.
const STAGES = [
  { name: "main", rooms: MAIN, bridge: { only: MAIN, claude: real ? "real" : "fake" }, tests: [
    { file: "test.mjs" }, { file: "test-upload.mjs" }, { file: "compact.test.mjs", room: "test-compact" }, { file: "test-status-bar.mjs", room: "test-status-bar" },
    { file: "reconnect.test.mjs", room: "test-reconnect", browser: true }, { file: "test-statusbar-live.mjs", room: "test-statusbar-live", browser: true },
    { file: "test-boot.mjs", browser: true }, { file: "test-cobrowse.mjs", room: "test-cobrowse", browser: true }] },
  // host login: a stub claude, because the real `claude auth login` opens a browser and rewrites the host's credentials (auth.test.mjs)
  { name: "auth", rooms: ["test-auth"], bridge: s => ({ only: ["test-auth"], claude: STUB("test-auth-claude-stub.mjs"), extraEnv: { JAM_AUTH_STATE: path.join(s.dir, "auth-state.json"), JAM_AUTH_GOOD_CODE: "good-code", JAM_AUTH_COUNT: path.join(s.dir, "auth-count") } }),
    setup: s => fs.writeFileSync(path.join(s.dir, "auth-state.json"), '{"loggedIn":false}'), tests: s => [{ file: "auth.test.mjs", room: "test-auth", env: { JAM_AUTH_GOOD_CODE: "good-code", JAM_AUTH_COUNT: path.join(s.dir, "auth-count") } }] },
  // "Run commands on this machine": a stub claude that runs the real approval hook with the env the bridge gave it
  { name: "runlocal", platform: "darwin", why: "card-free driver commands are only honoured under the macOS Seatbelt sandbox", rooms: ["test-runlocal"], bridge: { only: ["test-runlocal"], claude: STUB("test-runlocal-claude-stub.mjs") }, tests: [{ file: "runlocal.test.mjs", room: "test-runlocal" }] },
  // model switching: Haiku and Opus capped, Sonnet's window shrunk (test hooks), then every model capped
  { name: "switch", rooms: ["test-switch"], bridge: { only: ["test-switch"], claude: real ? "real" : "fake", extraEnv: { JAM_CAPPED: "claude-haiku-4-5-20251001,claude-opus-5", JAM_WINDOWS: '{"claude-sonnet-5":20000}' } }, tests: [{ file: "switch.test.mjs", room: "test-switch" }] },
  { name: "switch-capped", rooms: ["test-switch"], bridge: { only: ["test-switch"], claude: real ? "real" : "fake", extraEnv: { JAM_CAPPED: "claude-haiku-4-5-20251001,claude-sonnet-5,claude-opus-5" } }, tests: [{ file: "switch.test.mjs", room: "test-switch", env: { ALL_CAPPED: "1" }, label: "switch.test.mjs (all capped)" }] },
];
// --only <x>: an exact file name (test.mjs, or the name without .mjs / .test.mjs: "compact") wins; otherwise a substring ("statusbar").
// Without the exact rule, `--only test.mjs` also selected every *.test.mjs.
const ALL_FILES = STAGES.flatMap(st => (typeof st.tests === "function" ? st.tests({ dir: "" }) : st.tests).map(t => t.file));
const exact = (o, f) => f === o || f === o + ".mjs" || f === o + ".test.mjs";
const wanted = t => !only.length || only.some(o => (ALL_FILES.some(f => exact(o, f)) ? exact(o, t.file) : t.file.includes(o)));

const t0 = Date.now(); const rows = [];
const stack = await startStack({ keep, quiet: true });
console.log(`e2e: local Worker on ${stack.url} (build ${stack.hash}), ${real ? "REAL claude" : "fake claude"}${keep ? `, state kept in ${stack.dir}` : ""}`);
const work = n => { const d = path.join(stack.dir, "work", n); fs.mkdirSync(d, { recursive: true }); return d; };
const sessions = () => path.join(stack.homeDir, ".jam", "sessions");

try {
  for (const st of STAGES) {
    const tests = (typeof st.tests === "function" ? st.tests(stack) : st.tests).filter(wanted);
    if (!tests.length) continue;
    console.log(`\n── ${st.name}`);
    if (st.platform && process.platform !== st.platform) { // a stage that cannot run here is SKIPPED loudly, never counted as passed
      for (const t of tests) { console.log(`   SKIPPED  ${t.label || t.file}  (${st.why}; this is ${process.platform})`); rows.push({ name: t.label || t.file, status: "skipped" }); }
      continue;
    }
    if (st.setup) st.setup(stack);
    try { for (const f of fs.readdirSync(sessions())) if (/^test-/.test(f)) fs.rmSync(path.join(sessions(), f), { recursive: true, force: true }); } catch {}
    for (const r of st.rooms) await stack.api("/rooms", { method: "POST", body: { name: r, cwd: work(r) } });
    const bridge = stack.startBridge({ ...(typeof st.bridge === "function" ? st.bridge(stack) : st.bridge), label: "bridge-" + st.name });
    // wait until the bridge has opened every room: tests that look at hello.bridge must not race it
    for (let i = 0; i < 150 && !st.rooms.every(r => bridge.output().includes(`#${r} connected`)); i++) { if (bridge.child.exitCode !== null) break; await sleep(200); }
    if (!st.rooms.every(r => bridge.output().includes(`#${r} connected`))) console.log(`   (the bridge did not open every room in time)\n${bridge.output().slice(-600)}`);
    for (const t of tests) {
      const name = t.label || t.file;
      if (t.browser && !browserOk) { console.log(`   SKIPPED  ${name}  (no Chromium: --no-browser)`); rows.push({ name, status: "skipped" }); continue; }
      const t1 = Date.now();
      const env = stack.env({ K: stack.key, ...(t.room ? { ROOM: t.room } : {}), ...(t.env || {}) });
      const res = await runToEnd(process.execPath, [path.join(ROOT, t.file)], { env, cwd: ROOT, label: t.file, timeoutMs: 420000 });
      fs.writeFileSync(path.join(logDir, name.replace(/[^\w.-]+/g, "_") + ".log"), res.output);
      const lines = res.output.split(/\r?\n/), passes = lines.filter(l => /^PASS\b/.test(l)).length, fails = lines.filter(l => /^FAIL\b/.test(l));
      const bad = res.timedOut ? "timed out" : res.code !== 0 ? `exited ${res.code}` : fails.length ? `${fails.length} FAIL` : passes === 0 ? "printed no PASS lines (it never really ran)" : "";
      rows.push({ name, status: bad ? "fail" : "pass", passes, fails: fails.length, bad, secs: Math.round((Date.now() - t1) / 1000) });
      console.log(`   ${bad ? "✗ FAIL" : "✓ pass"}  ${name}  ${passes} pass${fails.length ? `, ${fails.length} fail` : ""}  (${rows.at(-1).secs}s)${bad && !fails.length ? "  — " + bad : ""}`);
      for (const l of fails.slice(0, 8)) console.log("      " + l.slice(0, 200));
      if (bad) { const tail = res.output.trim().split(/\r?\n/).slice(-14).join("\n      "); if (tail) console.log("      …\n      " + tail.slice(0, 1800)); }
    }
    bridge.stop();
    for (const r of st.rooms) await stack.api(`/rooms/${r}`, { method: "DELETE" });
    if (rows.some(r => r.status === "fail")) fs.writeFileSync(path.join(logDir, `bridge-${st.name}.log`), bridge.output());
  }
} finally { await stack.stop(); }

const fails = rows.filter(r => r.status === "fail"), skipped = rows.filter(r => r.status === "skipped");
const total = rows.filter(r => r.status !== "skipped").reduce((n, r) => n + (r.passes || 0), 0);
console.log(`\ne2e: ${rows.length - fails.length - skipped.length} of ${rows.length - skipped.length} test files passed (${total} checks) in ${Math.round((Date.now() - t0) / 1000)}s${skipped.length ? `, ${skipped.length} SKIPPED (not verified)` : ""}${fails.length ? ` — ${fails.length} FAILED: ${fails.map(f => f.name).join(", ")}` : ""}`);
if (!rows.length) { console.error("e2e: no tests matched"); process.exit(1); }
if (fails.length) console.log(`logs: ${logDir}`);
process.exit(fails.length ? 1 : 0);
