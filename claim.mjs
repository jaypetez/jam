#!/usr/bin/env node
// Claim a host on a hosted jam hub with a one-time host code, so this machine's bridge can run rooms on YOUR Claude.
//   node claim.mjs <host-code> <host-name> [--host jam.nullagency.io] [--force]
// The owner key is made here and never leaves this machine: the hub only ever receives sha256 of its secret part.
// Writes .jam-key (mode 600) and JAM_HOST in .env next to this script; then ./run.sh starts the bridge.
import { httpBase } from "./jam-url.mjs";
import crypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf("--" + n); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const force = argv.includes("--force"); if (force) argv.splice(argv.indexOf("--force"), 1);
const host = (flag("host") || process.env.JAM_HOST || "jam.nullagency.io").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
const [code, name] = argv;
const die = m => { console.error("✗ " + m); process.exit(1); };

if (!code || !name) die("usage: node claim.mjs <host-code> <host-name>   (host-name: 3–20 lowercase letters/digits, shows in your invite links)");
if (!/^[a-z0-9]{3,20}$/.test(name)) die("host-name must be 3–20 lowercase letters and digits");
const keyFile = path.join(here, ".jam-key");
if (existsSync(keyFile) && !force) die(".jam-key already exists here — this folder is already set up. Use --force only if you mean to replace it.");

const ALPHA = "abcdefghijkmnpqrstuvwxyz23456789";
const secret = [...crypto.randomBytes(32)].map(b => ALPHA[b % 32]).join("");
const hash = crypto.createHash("sha256").update(secret).digest("hex");

const res = await fetch(`${httpBase(host)}/api/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, tenant: name, hash }) }).catch(e => die(`can't reach ${host}: ${e.message}`));
const d = await res.json().catch(() => ({}));
if (!d.ok) die(d.error || `claim failed (HTTP ${res.status})`);

const key = `jamo_${name}_${secret}`;
writeFileSync(keyFile, key + "\n", { mode: 0o600 }); chmodSync(keyFile, 0o600);
const envFile = path.join(here, ".env");
const envTxt = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
writeFileSync(envFile, (/^JAM_HOST=/m.test(envTxt) ? envTxt.replace(/^JAM_HOST=.*$/m, `JAM_HOST=${host}`) : envTxt + (envTxt && !envTxt.endsWith("\n") ? "\n" : "") + `JAM_HOST=${host}\n`), { mode: 0o600 });

const hasClaude = spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).status === 0;
console.log(`
✓ You're host "${name}" on ${host}. Your owner key is in .jam-key (only on this machine — keep it private).

Next:
  1. Start your bridge (keep it running):   ./run.sh
  2. Open your lobby and make a room:       ${httpBase(host)}/?k=${key}
     (that link IS your owner key — don't share it; share invite links from inside a room instead)
${hasClaude ? "" : "\n  ⚠ The claude CLI isn't on your PATH. Install Claude Code and run `claude` once to sign in.\n"}
Who pays: every turn runs on THIS machine's Claude. Your own messages use your Claude Code login.
To let other people DRIVE (send messages) in your rooms, add your Anthropic API key to .env:
  JAM_DRIVER_API_KEY=sk-ant-...
Their turns then bill that key; without it, the bridge refuses guests' messages (Anthropic's consumer terms don't
allow sharing a Claude subscription). Viewers can always watch.
${process.platform === "darwin" ? "" : "\n⚠ Not macOS: the driver sandbox (Seatbelt) is unavailable here, so the Allow card is the only gate on what\n  guests' turns run. Only invite drivers you trust.\n"}`);
