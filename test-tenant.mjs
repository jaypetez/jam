// Hosted tenants, end to end against the LIVE Worker (run-tests.sh): claim via the real /dl/jam.tgz + claim.mjs, isolation
// between two hosts and the root, invites, disable/enable/delete, and a real tenant bridge (from the bundle, stub claude)
// enforcing the guest-turn rule. Two throwaway hosts (qa<random>) are disabled + deleted at the end, pass or fail.
import { httpBase, wsBase } from "./jam-url.mjs";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, statSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import os from "node:os"; import path from "node:path"; import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const H = process.env.JAM_HOST || "jam.nullagency.io", RK = process.env.K || readFileSync(path.join(here, ".jam-key"), "utf8").trim();
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const api = async (p, k, o = {}) => { const r = await fetch(`${httpBase(H)}${p}${p.includes("?") ? "&" : "?"}k=${encodeURIComponent(k)}`, { ...o, headers: { "content-type": "application/json", ...(o.headers || {}) } }); let d = {}; try { d = await r.json(); } catch {} return { status: r.status, ...d }; };
const rnd = () => Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, "x");
const A = "qa" + rnd(), B = "qa" + rnd(), room = "test-tn-" + rnd();
const tmp = mkdtempSync(path.join(os.tmpdir(), "jamtn-")), dirA = path.join(tmp, "a"), cwd = path.join(tmp, "cwd"); mkdirSync(dirA); mkdirSync(cwd);
let bridge = null, keyA = "", keyB = "";

function sock(k, rm, name = "qa") { // a room socket that records every event
  const ws = new WebSocket(`${wsBase(H)}/ws?room=${encodeURIComponent(rm)}&k=${encodeURIComponent(k)}&name=${name}`); const ev = [];
  ws.onmessage = e => { try { ev.push(JSON.parse(e.data)); } catch {} };
  const open = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; ws.onclose = c => rej(new Error("closed " + c.code)); });
  const closed = new Promise(res => ws.addEventListener("close", c => res(c.code)));
  return { ws, ev, open, closed, say: t => ws.send(JSON.stringify({ type: "say", text: t })), wait: async (f, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const x = ev.find(f); if (x) return x; await new Promise(r => setTimeout(r, 200)); } return null; } };
}
const startBridge = (extraEnv = {}) => { const b = spawn(process.execPath, ["bridge.mjs"], { cwd: dirA, env: { ...process.env, JAM_KEY: "", JAM_HOST: H, JAM_ONLY: room, JAM_CATALOG: "off", JAM_CLAUDE: path.join(here, "test-tenant-claude-stub.mjs"), ANTHROPIC_API_KEY: "", ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] }); let out = ""; b.stdout.on("data", d => out += d); b.stderr.on("data", d => out += d); b.log = () => out; return b; };
const stopBridge = async () => { if (!bridge) return; bridge.kill("SIGTERM"); await new Promise(r => setTimeout(r, 1500)); bridge = null; };

try {
  // ── claim through the real public bundle ──
  const tgz = Buffer.from(await (await fetch(`${httpBase(H)}/dl/jam.tgz`)).arrayBuffer());
  writeFileSync(path.join(tmp, "jam.tgz"), tgz); execFileSync("tar", ["xzf", path.join(tmp, "jam.tgz"), "-C", dirA, "--strip-components", "1"]);
  ok(existsSync(path.join(dirA, "claim.mjs")) && existsSync(path.join(dirA, "bridge.mjs")) && !existsSync(path.join(dirA, ".jam-key")), "bundle: /dl/jam.tgz has claim.mjs + bridge.mjs and no key");
  const codeA = await api("/api/hosts/codes", RK, { method: "POST", body: JSON.stringify({ note: A }) });
  ok(codeA.ok && /^[a-z0-9]{24}$/.test(codeA.code), "root mints a host code");
  const cl = execFileSync(process.execPath, ["claim.mjs", codeA.code, A, "--host", H], { cwd: dirA, encoding: "utf8", env: { ...process.env, JAM_HOST: "" } });
  keyA = readFileSync(path.join(dirA, ".jam-key"), "utf8").trim();
  ok(/^jamo_[a-z0-9]+_[a-z0-9]{32}$/.test(keyA) && keyA.startsWith(`jamo_${A}_`), "claim.mjs writes a jamo_ key");
  ok((statSync(path.join(dirA, ".jam-key")).mode & 0o777) === 0o600, ".jam-key is 600");
  ok(/JAM_HOST=/.test(readFileSync(path.join(dirA, ".env"), "utf8")) && /\.\/run\.sh/.test(cl), ".env gets JAM_HOST and next steps print");
  const again = await fetch(`${httpBase(H)}/api/claim`, { method: "POST", body: JSON.stringify({ code: codeA.code, tenant: "qa" + rnd(), hash: "a".repeat(64) }) });
  ok(again.status === 409, "a used host code can't be claimed again (" + again.status + ")");
  const codeB = await api("/api/hosts/codes", RK, { method: "POST", body: JSON.stringify({ note: B }) });
  const taken = await fetch(`${httpBase(H)}/api/claim`, { method: "POST", body: JSON.stringify({ code: codeB.code, tenant: A, hash: "b".repeat(64) }) });
  ok(taken.status === 409, "a taken host name is refused");
  const resv = await fetch(`${httpBase(H)}/api/claim`, { method: "POST", body: JSON.stringify({ code: codeB.code, tenant: "admin", hash: "b".repeat(64) }) });
  ok(resv.status === 400, "a reserved host name is refused");
  // B claims by hand (hash only), to prove the secret never needs to travel
  const secretB = "b2" + rnd() + rnd() + rnd() + rnd() + rnd(); const { createHash } = await import("node:crypto");
  const cb = await fetch(`${httpBase(H)}/api/claim`, { method: "POST", body: JSON.stringify({ code: codeB.code, tenant: B, hash: createHash("sha256").update(secretB).digest("hex") }) });
  ok(cb.status === 200, "B claims with only a hash"); keyB = `jamo_${B}_${secretB}`;

  // ── auth + isolation ──
  const wa = await api("/api/whoami", keyA); ok(wa.ok && wa.host === A && wa.root === false && wa.role === "owner", "A's key is owner of host A, not root");
  ok((await api("/api/whoami", `jamo_${A}_${"x".repeat(32)}`)).status === 403, "a wrong secret for A is refused");
  ok((await api("/api/whoami", RK)).root === true, "root key is root");
  ok((await api("/api/rooms", keyA, { method: "POST", body: JSON.stringify({ name: room, cwd }) })).ok, "A creates #" + room);
  ok((await api("/api/rooms", keyB, { method: "POST", body: JSON.stringify({ name: room, cwd: "/tmp" }) })).ok, "B creates a room with the SAME name (no collision)");
  const ra = await api("/api/rooms", keyA), rr = await api("/api/rooms", RK);
  ok(ra.rooms.length === 1 && ra.rooms[0].cwd === cwd, "A sees only its own room");
  ok(!rr.rooms.some(r => r.name === room), "root's lobby doesn't see hosts' rooms");
  const spoof = await api("/api/rooms", keyA, { headers: { "x-jam-tenant": B } });
  ok(spoof.rooms && spoof.rooms.length === 1 && spoof.rooms[0].cwd === cwd, "a forged x-jam-tenant header is ignored");
  ok((await api("/api/hosts", keyA)).status === 403, "a host can't list hosts");
  ok((await api("/api/hosts/codes", keyA, { method: "POST", body: "{}" })).status === 403, "a host can't mint host codes");
  ok((await api("/api/sponsor", keyA, { method: "POST", body: JSON.stringify({ name: "evil" }) })).status === 403, "a host can't set the sponsor");
  ok((await api(`/api/rooms/jam/settings`, keyA, { method: "POST", body: JSON.stringify({ model: "auto" }) })).status === 404, "a host can't touch the root's #jam");
  for (const p of ["/api/kick-all", "/api/wipe-all"]) ok((await api(p, keyA, { method: "POST" })).status === 404, "internal " + p + " is blocked");
  // invites
  const inv = await api(`/api/rooms/${room}/invites`, keyA, { method: "POST", body: JSON.stringify({ role: "driver", name: "guest" }) });
  ok(inv.ok && inv.token.startsWith(A + "."), "A's invite is prefixed with its host name");
  const wi = await api("/api/whoami", inv.token); ok(wi.ok && wi.host === A && wi.role === "driver" && wi.room?.name === room, "A's invite resolves to A's room");
  ok((await api("/api/whoami", B + inv.token.slice(A.length))).status === 403, "re-prefixing A's token with B is refused");
  ok((await api("/api/whoami", inv.token.slice(A.length + 1))).status === 403, "A's token without its prefix is refused at the root");
  ok((await api(`/api/rooms/${room}/invites`, inv.token)).status === 403, "a driver invite can't list invites");
  // room isolation over websockets: a message in A's room never shows in B's same-named room
  const sa = sock(keyA, room, "ownerA"); await sa.open; sa.say("hello from A " + A);
  const sb = sock(keyB, room, "ownerB"); await sb.open; await new Promise(r => setTimeout(r, 1500));
  const helloB = sb.ev.find(e => e.type === "hello");
  ok(helloB && !JSON.stringify(helloB.log || []).includes("hello from A"), "B's same-named room has none of A's transcript");
  sb.ws.close();
  // room cap
  let capHit = 0; for (let i = 0; i < 20; i++) { const r = await api("/api/rooms", keyB, { method: "POST", body: JSON.stringify({ name: "cap" + i, cwd: "/tmp" }) }); if (r.status === 403) { capHit = i; break; } }
  ok(capHit === 19, "a host is capped at 20 rooms (21st refused at #" + capHit + ")");

  // ── a real tenant bridge from the bundle: owner turn runs, guest turn refused without an API key, allowed with one ──
  bridge = startBridge(); await new Promise(r => setTimeout(r, 4000));
  const ownerDone = await sa.wait(e => e.type === "done" && /TENANT-STUB/.test(e.text || ""), 45000);
  ok(ownerDone && /key=unset/.test(ownerDone.text) && /leak=no/.test(ownerDone.text), "tenant bridge runs the host's own turn on the host's login (no API key injected): " + (ownerDone?.text || "no reply"));
  const sg = sock(inv.token, room, "guest"); await sg.open; sg.say("guest says hi");
  const refused = await sa.wait(e => e.type === "error" && /guest turns/.test(e.text || ""), 30000);
  ok(!!refused, "a guest's turn is refused when the host has no JAM_DRIVER_API_KEY");
  await stopBridge();
  bridge = startBridge({ JAM_DRIVER_API_KEY: "sk-ant-test-123" }); await new Promise(r => setTimeout(r, 4000));
  sg.say("guest again");
  const guestDone = await sa.wait(e => e.type === "done" && /role=driver/.test(e.text || ""), 45000);
  ok(guestDone && /key=sk-ant-/.test(guestDone.text) && /leak=no/.test(guestDone.text), "with JAM_DRIVER_API_KEY the guest's turn bills that key, and the raw var never reaches claude: " + (guestDone?.text || "no reply"));
  sa.say("owner again"); await new Promise(r => setTimeout(r, 300));
  const ownerAgain = await sa.wait(e => e.type === "done" && /role=owner/.test(e.text || "") && e !== ownerDone, 45000);
  ok(ownerAgain && /key=unset/.test(ownerAgain.text), "…while the host's own turns still don't get the API key");
  ok(!/another bridge .* stopping it/.test(bridge.log()), "the tenant bridge never tried to stop the root's live bridge");

  // ── disable cuts everything at once; enable restores; delete only when disabled ──
  ok((await api(`/api/hosts/${A}`, RK, { method: "DELETE" })).status === 409, "an enabled host can't be deleted");
  const before = sg.closed;
  ok((await api(`/api/hosts/${A}/disable`, RK, { method: "POST", body: JSON.stringify({ disabled: true }) })).ok, "root disables A");
  const code = await Promise.race([before, new Promise(r => setTimeout(() => r("open"), 8000))]);
  ok(code === 4003, "A's live guest socket is closed at once (" + code + ")");
  ok((await api("/api/whoami", keyA)).status === 403 && (await api("/api/whoami", inv.token)).status === 403, "A's key and A's invites stop working");
  ok((await api("/api/rooms", keyB)).ok, "B is unaffected");
  ok((await api(`/api/hosts/${A}/disable`, RK, { method: "POST", body: JSON.stringify({ disabled: false }) })).ok && (await api("/api/whoami", keyA)).ok, "re-enabling A restores its key");
} catch (e) { ok(false, "crashed: " + (e.stack || e.message)); }
finally {
  await stopBridge();
  for (const t of [A, B]) { await api(`/api/hosts/${t}/disable`, RK, { method: "POST", body: JSON.stringify({ disabled: true }) }); const d = await api(`/api/hosts/${t}`, RK, { method: "DELETE" }); if (!d.ok) console.log("cleanup: could not delete " + t, d.error || d.status); }
  const left = await api("/api/hosts", RK); ok(!(left.hosts || []).some(h => h.name === A || h.name === B), "cleanup: both test hosts deleted");
  if (keyA) ok((await api("/api/whoami", keyA)).status === 403, "a deleted host's key is dead");
  for (const c of (left.codes || [])) if (c.note === A || c.note === B) await api(`/api/hosts/codes/${c.code}`, RK, { method: "DELETE" });
  for (const f of [`queue-${room}.json`, `sessions/${room}.json`]) rmSync(path.join(os.homedir(), ".jam", f), { force: true });
  rmSync(tmp, { recursive: true, force: true });
}
console.log(fails ? `${fails} failures` : "all tenant checks passed");
process.exit(fails ? 1 : 0);
