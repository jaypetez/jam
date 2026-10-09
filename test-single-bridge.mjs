#!/usr/bin/env node
// A second full-scope bridge on the same hub must stop the first (newest wins); JAM_ONLY bridges must not.
// Uses a throwaway HOME and an unroutable host, so it can never touch the live bridge or hub.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "single-bridge-"));
const host = "jam-test.invalid", lock = path.join(home, ".jam", `bridge-${host}.pid`);
const env = { ...process.env, HOME: home, JAM_HOST: host, JAM_KEY: "x", JAM_CATALOG: "off" };
delete env.JAM_ONLY;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const start = (extra = {}) => spawn("node", ["bridge.mjs"], { env: { ...env, ...extra }, stdio: "ignore" });
let fail = 0; const check = (ok, name) => { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) fail++; };
const kids = [];
try {
  const a = start(); kids.push(a); await sleep(2500);
  check(fs.existsSync(lock) && +fs.readFileSync(lock, "utf8") === a.pid, "first bridge takes the lock");
  const b = start(); kids.push(b); await sleep(2500);
  check(!alive(a.pid), "second bridge stops the first");
  check(alive(b.pid) && +fs.readFileSync(lock, "utf8") === b.pid, "second bridge holds the lock");
  const c = start({ JAM_ONLY: "test-x" }); kids.push(c); await sleep(2500);
  check(alive(b.pid) && alive(c.pid), "a JAM_ONLY test bridge leaves the live one alone");
  check(+fs.readFileSync(lock, "utf8") === b.pid, "JAM_ONLY bridge does not take the lock");
  fs.writeFileSync(lock, "999999"); // stale pid that is not a bridge: must not be signalled or crash
  const d = start(); kids.push(d); await sleep(2500);
  check(alive(d.pid), "stale lock (dead pid) is ignored");
} finally { for (const k of kids) try { k.kill("SIGKILL"); } catch {} fs.rmSync(home, { recursive: true, force: true }); }
console.log(fail ? `${fail} FAILED` : "all passed"); process.exit(fail ? 1 : 0);
