#!/usr/bin/env node
// Offline end-to-end test of the bridge's turn lifecycle (2026-10-09). Before this, nothing in check.sh ran a turn: runOne, the retry
// paths, compaction and uploads were only exercised against the LIVE Worker (run-tests.sh). Here a throwaway TLS WebSocket server plays
// the Hub and the Room DO, and a stub `claude` (test-bridge-claude-stub.mjs) plays the CLI, so the real bridge.mjs runs a normal turn, a
// crash retry, a usage-cap fallback, duplicate-say dedupe, uploads, a /compact, and a driver turn, with no network and no credentials.
// Needs a POSIX host (the stub is a shebang script) and openssl (self-signed cert); skips cleanly otherwise.
import tls from "node:tls"; import crypto from "node:crypto"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
if (process.platform === "win32") { console.log("skip: test-bridge-turn needs a POSIX host (the stub claude is a shebang script)"); process.exit(0); }
const here = path.dirname(new URL(import.meta.url).pathname);
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-turn-")));
const cert = path.join(tmp, "c.pem"), keyf = path.join(tmp, "k.pem");
const ssl = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyf, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
if (ssl.status !== 0) { console.log("skip: openssl is not available to make a throwaway certificate"); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0); }

let fail = 0; const ok = (c, m, extra = "") => { console.log((c ? "PASS " : "FAIL ") + m + (c ? "" : " " + extra)); if (!c) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── a minimal WebSocket server: just enough RFC 6455 for one text-frame-per-message client (undici's WebSocket) ── */
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const frame = s => { const b = Buffer.from(s); const h = b.length < 126 ? Buffer.from([0x81, b.length]) : b.length < 65536 ? Buffer.from([0x81, 126, b.length >> 8, b.length & 255]) : (() => { const x = Buffer.alloc(10); x[0] = 0x81; x[1] = 127; x.writeBigUInt64BE(BigInt(b.length), 2); return x; })(); return Buffer.concat([h, b]); };
const sockets = []; // { path, got: [], send(obj) }
const server = tls.createServer({ key: fs.readFileSync(keyf), cert: fs.readFileSync(cert) }, sock => {
  let buf = Buffer.alloc(0), upgraded = false; const ws = { path: "", got: [], send: o => { try { sock.write(frame(JSON.stringify(o))); } catch {} } };
  sock.on("error", () => {});
  sock.on("data", d => {
    buf = Buffer.concat([buf, d]);
    if (!upgraded) {
      const end = buf.indexOf("\r\n\r\n"); if (end < 0) return;
      const head = buf.slice(0, end).toString(); buf = buf.slice(end + 4);
      ws.path = head.split(" ")[1]; const k = /sec-websocket-key:\s*(.+)/i.exec(head)[1].trim();
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${crypto.createHash("sha1").update(k + GUID).digest("base64")}\r\n\r\n`);
      upgraded = true; sockets.push(ws); onConnect(ws);
    }
    while (upgraded && buf.length >= 2) {
      const op = buf[0] & 15, masked = !!(buf[1] & 128); let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + (masked ? 4 : 0) + len) return;
      const mask = masked ? buf.slice(off, off + 4) : null; off += masked ? 4 : 0;
      const payload = Buffer.from(buf.slice(off, off + len)); if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.slice(off + len);
      if (op === 8) { sock.end(); return; }
      if (op === 9) { sock.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
      if (op === 1) { try { ws.got.push(JSON.parse(payload.toString())); } catch {} }
    }
  });
});

const roomName = "test-bt-room", workdir = path.join(tmp, "work"); fs.mkdirSync(workdir);
const home = path.join(tmp, "home"); fs.mkdirSync(home);
const onConnect = ws => { if (ws.path.startsWith("/hub")) ws.send({ type: "rooms", rooms: [{ name: roomName, cwd: workdir, model: "auto" }] }); };
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// The bridge reads the hub key from env/--key, but a driver turn only drops JAM_KEY when .jam-key exists on disk (the hook reads it there).
const keyFile = path.join(here, ".jam-key"), madeKey = !fs.existsSync(keyFile); if (madeKey) fs.writeFileSync(keyFile, "testkey\n");
const env = { ...process.env, HOME: home, USERPROFILE: home, JAM_HOST: `127.0.0.1:${port}`, JAM_KEY: "testkey", JAM_ONLY: roomName, JAM_CLAUDE: path.join(here, "test-bridge-claude-stub.mjs"), JAM_CATALOG: "off", NODE_TLS_REJECT_UNAUTHORIZED: "0", JAM_DRIVER_SANDBOX: "off", JAM_SCHEME: "https" /* the fake hub is TLS on a loopback address, which would otherwise default to plain ws (jam-url.mjs) */ };
delete env.JAM_ROOM; delete env.JAM_FROM; delete env.JAM_FROM_ROLE; delete env.JAM_TURN; delete env.JAM_CWD;
const bridge = spawn("node", ["bridge.mjs"], { cwd: here, env, stdio: ["ignore", "pipe", "pipe"] });
let bout = ""; bridge.stdout.on("data", d => bout += d); bridge.stderr.on("data", d => bout += d); bridge.on("error", e => { bout += "spawn error " + e.message; });
const cleanup = () => { try { bridge.kill("SIGKILL"); } catch {} try { server.close(); } catch {} if (madeKey) try { fs.unlinkSync(keyFile); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); };
process.on("exit", cleanup);

const room = () => sockets.find(s => s.path.startsWith("/ws?room=" + roomName));
const waitFor = async (pred, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = room(); const hit = r && r.got.find(pred); if (hit) return hit; await sleep(50); } return null; };
const say = (id, text, extra = {}) => room().send({ type: "say", id, text, from: "Ann", role: "owner", ts: Date.now(), attachments: [], ...extra });
const evs = id => room().got.filter(m => m.id === id);
const calls = () => { try { return fs.readFileSync(path.join(workdir, ".calls"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

try {
  ok(!!(await waitFor(m => m.type === "session", 20000)), "the bridge opens the room from the hub's room list and announces its session");
  ok(!!(await waitFor(m => m.type === "agents")), "…and its teammate list");

  // 1. a normal turn
  say("s1", "SCEN:ok please");
  const d1 = await waitFor(m => m.type === "done" && m.id === "s1");
  ok(!!d1, "a normal turn finishes with a done event");
  const e1 = evs("s1");
  ok(e1.some(m => m.type === "start") && e1.some(m => m.type === "route"), "…after start and a route decision");
  ok(e1.filter(m => m.type === "delta").map(m => m.text).join("").startsWith("ok model="), "…streaming the text as deltas", JSON.stringify(e1.filter(m => m.type === "delta")));
  const tool = e1.find(m => m.type === "tool");
  ok(tool && tool.name === "Bash" && tool.summary === "ls -la" && tool.label === "Running a command" && tool.input.command === "ls -la", "…with a tool card carrying a raw summary and a sanitized label", JSON.stringify(tool));
  ok(e1.some(m => m.type === "tool_result" && m.text === "file1\nfile2"), "…and its result");
  ok(d1 && /^ok model=\S+ mode=new$/.test(d1.text) && d1.cost === 0.01 && d1.ctx === 2000, "…the done text is what streamed, with cost and context", JSON.stringify(d1));
  ok(e1.some(m => m.type === "spend" && m.cost === 0.01), "…the attempt is metered with a spend event");
  await sleep(300);
  const sIdx = room().got.findIndex(m => m.type === "done" && m.id === "s1");
  ok(room().got.slice(sIdx).some(m => m.type === "session"), "…and a fresh session event follows the turn");
  ok(calls()[0]?.mode === "new" && calls()[0]?.model !== "unknown", "the first turn started a NEW session with a model chosen by the router", JSON.stringify(calls()[0]));

  // 2. the second turn resumes the session
  say("s2", "SCEN:ok again");
  const d2 = await waitFor(m => m.type === "done" && m.id === "s2");
  ok(d2 && /mode=resume$/.test(d2.text), "the next turn RESUMES that session", d2 && d2.text);

  // 3. a duplicate say (the Room DO replays its outbox on reconnect) runs once
  say("s3", "SCEN:ok dup"); say("s3", "SCEN:ok dup");
  await waitFor(m => m.type === "done" && m.id === "s3"); await sleep(600);
  ok(evs("s3").filter(m => m.type === "done").length === 1 && calls().filter(c => c.scen === "ok").length === 3, "a replayed say id runs exactly once", JSON.stringify(calls()));

  // 4. a crash with no result is retried once
  say("s4", "SCEN:crash-once");
  const d4 = await waitFor(m => m.type === "done" && m.id === "s4");
  ok(!!d4, "a turn whose process dies without a result still completes");
  ok(room().got.some(m => m.type === "sys" && /Claude exited unexpectedly; retrying/.test(m.text)), "…after telling the room it is retrying"); // sys events carry no turn id
  ok(calls().filter(c => c.scen === "crash-once").length === 2, "…by running it a second time", JSON.stringify(calls()));

  // 5. a usage cap is stepped around on another model
  say("s5", "SCEN:cap-once");
  const d5 = await waitFor(m => m.type === "done" && m.id === "s5");
  ok(!!d5, "a usage-capped turn completes");
  ok(room().got.some(m => m.type === "sys" && /hit its usage limit; retrying that message on another model/.test(m.text)), "…after announcing the retry");
  const cc = calls().filter(c => c.scen === "cap-once");
  ok(cc.length === 2 && cc[0].model !== cc[1].model, "…on a DIFFERENT model than the capped one", JSON.stringify(cc));
  ok(/model=/.test(d5 ? d5.text : "") && d5.text.includes(cc[1].model), "…and the answer came from the fallback", d5 && d5.text);

  // 6. the env a turn's claude sees: owners keep JAM_KEY, drivers never do (2026-10-09 review)
  say("s6", "SCEN:env", { role: "owner" });
  const d6 = await waitFor(m => m.type === "done" && m.id === "s6");
  ok(d6 && d6.text === "JAMKEY=present role=owner host=set", "an owner turn gets the hub key in its env", d6 && d6.text);
  say("s7", "SCEN:env", { role: "driver", from: "Dee" });
  const d7 = await waitFor(m => m.type === "done" && m.id === "s7");
  ok(d7 && d7.text === "JAMKEY=absent role=driver host=set", "a driver turn does NOT (the hook reads .jam-key from disk instead)", d7 && d7.text);
  ok(room().got.some(m => m.type === "colors" && m.colors && m.colors.Dee), "a first-time speaker is assigned a color and the room is told");

  // 7. uploads
  room().send({ type: "upload", id: "u1", name: "my notes.txt", seq: 0, total: 1, data: Buffer.from("hello upload").toString("base64"), from: "Ann" });
  const up = await waitFor(m => m.type === "uploaded" && m.id === "u1");
  ok(up && up.size === 12 && fs.readFileSync(up.path, "utf8") === "hello upload" && up.path.startsWith(path.join(home, ".jam", "uploads", roomName)), "an upload is written under ~/.jam/uploads/<room>/", JSON.stringify(up));
  room().send({ type: "upload", id: "u2", name: "x", seq: 0, total: 1e9, data: "AA", from: "Ann" });
  const bad = await waitFor(m => m.type === "upload_error" && m.id === "u2");
  ok(bad && bad.text === "bad upload", "a hostile upload size is refused before anything is allocated", JSON.stringify(bad));

  // 8. /compact: the session is replaced by a handoff, and the next turn is seeded with it
  say("s8", "/compact");
  const cmp = await waitFor(m => m.type === "compacted", 20000);
  ok(!!cmp, "/compact on a live session completes", bout.slice(-600));
  ok(room().got.some(m => m.type === "sys" && /^Compacted: .* fresh session started\./.test(m.text)), "…and tells the room what it did");
  const hand = fs.readdirSync(path.join(home, ".jam", "sessions")).filter(f => f.startsWith(roomName + "-handoff-"));
  ok(hand.length === 1 && fs.existsSync(path.join(home, ".jam", "sessions", roomName + ".seed.md")), "…saving the handoff and the seed", JSON.stringify(hand));
  ok(calls().some(c => c.json && c.mode === "resume"), "…by asking the existing session to write its own handoff");
  say("s9", "SCEN:handoff-check");
  const d9 = await waitFor(m => m.type === "done" && m.id === "s9");
  ok(d9 && d9.text === "seed=yes", "the next turn is fed the handoff", d9 && d9.text);
  say("s10", "SCEN:handoff-check");
  const d10 = await waitFor(m => m.type === "done" && m.id === "s10");
  ok(d10 && d10.text === "seed=no", "…once, not on every turn", d10 && d10.text);

  // 9. the whole thing ran without the bridge tripping over itself
  ok(bridge.exitCode === null, "the bridge is still running");
  ok(!/ReferenceError|TypeError|Unhandled|SyntaxError/.test(bout), "…and logged no runtime errors", bout.split("\n").filter(l => /Error|Unhandled/.test(l)).slice(0, 5).join(" | "));
} catch (e) { ok(false, "test harness threw: " + (e && e.stack || e)); }
if (fail) console.log("\n--- bridge output ---\n" + bout.slice(-3000));
console.log(fail ? `${fail} FAILED` : "all passed"); process.exit(fail ? 1 : 0);
