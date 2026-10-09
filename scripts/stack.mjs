// The local jam stack: the REAL Worker (wrangler dev on workerd, with real Durable Objects) plus helpers to run real bridges against it. Used by
// `npm run dev`, `npm run e2e` and test-stack.mjs. Nothing here touches production or the host's ~/.jam: every piece of state (Worker storage,
// bridge HOME, wrangler config and logs) lives in one throwaway directory that stop() deletes. Plain http/ws on loopback (see jam-url.mjs).
//
// Teardown is the hard part: `wrangler dev` is a tree (npx, wrangler, a node child, workerd x2) and killing only the pid we spawned leaves workerd
// holding the port. We kill the whole tree (taskkill /T on Windows, a process group elsewhere), on stop(), on exit and on SIGINT/SIGTERM.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const live = new Set(); // every child we started: killed on exit so an aborted run never leaves workerd behind

export function killTree(child) {
  if (!child || child.pid == null || child.exitCode !== null) return;
  try {
    if (WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } } // negative pid = the whole process group (spawned detached)
  } catch {}
}
const killAll = () => { for (const c of live) killTree(c); live.clear(); };
process.on("exit", killAll);
// Ctrl-C: kill the trees right away; exit only if nobody else is listening (a caller like dev.mjs adds its own handler to clean up asynchronously, then exits).
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { killAll(); if (process.listenerCount(sig) <= 1) process.exit(130); });

export function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); });
}

// Run a child we own: detached on POSIX (own process group, so killTree can take the tree), output captured, errors never thrown into the void.
export function run(cmd, args, { env, cwd, label = cmd } = {}) {
  const child = spawn(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"], detached: !WIN, windowsHide: true });
  const out = []; const take = d => { out.push(String(d)); if (out.length > 4000) out.splice(0, 2000); };
  child.stdout.on("data", take); child.stderr.on("data", take);
  child.on("error", e => out.push(`[${label}: spawn error ${e.message}]\n`));
  child.on("exit", () => live.delete(child));
  live.add(child);
  return { child, output: () => out.join(""), label };
}

// Run a child to completion (a test file) with a hard timeout; the whole tree is killed on timeout. Resolves { code, output, timedOut } and never rejects.
export function runToEnd(cmd, args, { env, cwd, label = cmd, timeoutMs = 300000 } = {}) {
  const r = run(cmd, args, { env, cwd, label });
  return new Promise(res => {
    let timedOut = false; const t = setTimeout(() => { timedOut = true; killTree(r.child); }, timeoutMs);
    r.child.on("exit", code => { clearTimeout(t); res({ code, output: r.output(), timedOut }); });
    r.child.on("error", () => { clearTimeout(t); res({ code: -1, output: r.output(), timedOut }); });
  });
}

// Rebuild worker.js from its sources (build.sh needs bash, shasum, base64 and sed: present on macOS, Linux and Git Bash for Windows).
export function buildWorker() {
  const r = spawnSync("bash", ["build.sh"], { cwd: ROOT, encoding: "utf8" });
  if (r.error || r.status !== 0) throw new Error(`could not build worker.js (needs bash): ${r.error?.message || r.stderr || r.stdout}`);
  const m = /const BUILD="([0-9a-f]+)"/.exec(fs.readFileSync(path.join(ROOT, "worker.js"), "utf8")); // line 1: `const B64="..."; const BUILD="<hash>";`
  if (!m) throw new Error("worker.js has no BUILD hash");
  return m[1];
}

// Playwright finds its browsers relative to HOME (~/.cache/ms-playwright on Linux), and tests run with a throwaway HOME. So resolve the real browsers
// directory up front, from the real environment, and hand it to every child as PLAYWRIGHT_BROWSERS_PATH. Windows (%LOCALAPPDATA%) never needed this,
// which is how it passed locally and failed on Linux CI-alike runs.
export async function browsersPath() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  try { const { chromium } = await import("playwright"); const parts = chromium.executablePath().split(path.sep), i = parts.lastIndexOf("ms-playwright"); return i > 0 ? parts.slice(0, i + 1).join(path.sep) || path.sep : null; } catch { return null; }
}

/** Start the Worker. Returns { host, url, key, dir, homeDir, env(extra), startBridge(opts), stop(), log() }. */
export async function startStack({ keep = false, quiet = true, build = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jam-stack-")));
  const homeDir = path.join(dir, "home"), stateDir = path.join(dir, "state"), cfgDir = path.join(dir, "cfg"), logDir = path.join(dir, "logs");
  for (const d of [homeDir, stateDir, cfgDir, logDir]) fs.mkdirSync(d, { recursive: true });
  const hash = build ? buildWorker() : null;
  const key = crypto.randomBytes(24).toString("hex"); // throwaway: lives only in this stack
  const port = await freePort();
  // wrangler config generated into the temp dir (with .dev.vars beside it), so the repo's wrangler.toml and the key never touch argv or the working tree
  const toml = `name = "jam-local"\nmain = ${JSON.stringify(path.join(ROOT, "worker.js"))}\ncompatibility_date = "2025-06-01"\n\n[durable_objects]\nbindings = [\n  { name = "ROOM", class_name = "Room" },\n  { name = "HUB", class_name = "Hub" },\n]\n\n[[migrations]]\ntag = "v1"\nnew_sqlite_classes = ["Room", "Hub"]\n`;
  fs.writeFileSync(path.join(dir, "wrangler.toml"), toml); fs.writeFileSync(path.join(dir, ".dev.vars"), `JAM_KEY=${key}\n`);
  const wrangler = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  if (!fs.existsSync(wrangler)) throw new Error("wrangler is not installed: run `npm ci` first");
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: logDir, XDG_CONFIG_HOME: cfgDir, HOME: homeDir, USERPROFILE: homeDir, NO_COLOR: "1", CI: "1" };
  const w = run(process.execPath, [wrangler, "dev", "--config", path.join(dir, "wrangler.toml"), "--local", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0", "--persist-to", stateDir], { env, cwd: dir, label: "wrangler" });
  const host = `127.0.0.1:${port}`, url = `http://${host}`;
  const bridges = [];
  const pw = await browsersPath();
  const stack = {
    dir, homeDir, host, url, key, hash, worker: w,
    log: () => w.output(),
    // the environment a bridge or test child needs to reach this stack and nothing else (no JAM_ROOM/JAM_FROM leftovers from an outer jam room)
    env(extra = {}) {
      const e = { ...process.env, HOME: homeDir, USERPROFILE: homeDir, JAM_HOST: host, JAM_SCHEME: "http", JAM_CATALOG: "off", ...(pw ? { PLAYWRIGHT_BROWSERS_PATH: pw } : {}), ...extra };
      for (const k of ["JAM_ROOM", "JAM_FROM", "JAM_FROM_ROLE", "JAM_TURN", "JAM_CWD", "JAM_ONLY", "JAM_KEY"]) if (!(k in extra)) delete e[k];
      return e;
    },
    // start a real bridge.mjs against this stack. `claude` = "fake" (default), "real" (the host's claude), or a path to a script/binary.
    startBridge({ only = [], claude = "fake", extraEnv = {}, label = "bridge" } = {}) {
      const claudePath = claude === "fake" ? path.join(ROOT, "dev", "fake-claude.mjs") : claude === "real" ? null : claude;
      const e = stack.env({ ...(only.length ? { JAM_ONLY: only.join(",") } : {}), ...(claudePath ? { JAM_CLAUDE: claudePath } : {}), JAM_KEY: key, JAM_FAKE_HUB_KEY: key, ...extraEnv }); // JAM_FAKE_HUB_KEY: a dev machine may have a real .jam-key in the repo, which the hook would read instead of this stack's key (the bridge drops JAM_KEY from driver env when that file exists)
      const b = run(process.execPath, [path.join(ROOT, "bridge.mjs")], { env: e, cwd: ROOT, label });
      bridges.push(b); b.stop = () => killTree(b.child); return b;
    },
    async api(p, { method = "GET", body, k = key } = {}) {
      const r = await fetch(`${url}/api${p}${p.includes("?") ? "&" : "?"}k=${k}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
      let data = null; try { data = await r.json(); } catch {} return { status: r.status, data };
    },
    async stop() {
      for (const b of bridges) killTree(b.child);
      killTree(w.child);
      for (let i = 0; i < 50 && await portOpen(port); i++) await sleep(100); // the port must be free again before we report done
      if (!keep) { for (let i = 0; i < 20; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(150); } } }
    },
  };
  // wait for the Worker: /health must answer with the build hash we just built
  const t0 = Date.now(); let ok = false;
  while (Date.now() - t0 < 90000) {
    if (w.child.exitCode !== null) break;
    try { const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) }); const j = await r.json(); if (j.ok && (!hash || j.build === hash)) { ok = true; break; } } catch {}
    await sleep(250);
  }
  if (!ok) { const out = w.output().slice(-3000); await stack.stop(); throw new Error(`the local Worker did not come up on ${host}:\n${out}`); }
  if (!quiet) console.log(`local Worker up on ${url} (build ${hash})`);
  return stack;
}

export function portOpen(port) {
  return new Promise(res => { const s = net.connect({ port, host: "127.0.0.1" }); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); });
}
export { sleep, pathToFileURL };
