#!/usr/bin/env node
// Offline test of the LOCAL STACK (scripts/stack.mjs): the real Worker on workerd with real Durable Objects, a real bridge, the fake claude.
// This is the first test that exercises the Room and Hub Durable Objects' websocket paths without Cloudflare: hello frames, hibernation-API
// sockets, storage that survives a reconnect, role gates on the socket, and the bridge <-> Room relay. It also proves the stack tears down clean.
// Needs `npm ci` (wrangler) and bash (build.sh). Skips with a clear message if wrangler is not installed.
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { startStack, portOpen, sleep } from "./scripts/stack.mjs";
if (!fs.existsSync(new URL("./node_modules/wrangler/bin/wrangler.js", import.meta.url))) { console.log("skip: wrangler is not installed (run `npm ci`)"); process.exit(0); }

let fail = 0; const ok = (c, m, extra = "") => { console.log((c ? "PASS " : "FAIL ") + m + (c ? "" : " " + extra)); if (!c) fail++; };
const t0 = Date.now();
const stack = await startStack({ quiet: true });
const { host, url, key } = stack;
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "stack-room-")); const room = "st-room";
let bridge = null; const socks = [];
const open = async (query, name) => {
  const ws = new WebSocket(`ws://${host}/ws?${query}`); const evs = []; ws.onmessage = e => { try { evs.push(JSON.parse(e.data)); } catch {} };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`websocket ${name || query} failed`)); });
  socks.push(ws); ws.evs = evs; return ws;
};
const waitFor = async (evs, pred, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const h = evs.find(pred); if (h) return h; await sleep(40); } return null; };
const finish = async () => {
  for (const s of socks) { try { s.close(); } catch {} }
  const dir = stack.dir, port = Number(host.split(":")[1]);
  await stack.stop();
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  ok(!(await portOpen(port)), "teardown: the Worker's port is free again (no workerd left holding it)");
  ok(!fs.existsSync(dir), "teardown: the temp state directory is gone");
  console.log(fail ? `${fail} FAILED` : `all passed (${Math.round((Date.now() - t0) / 1000)}s)`); process.exit(fail ? 1 : 0);
};

try {
  // ── the Worker itself
  let r = await fetch(`${url}/health`).then(r => r.json());
  ok(r.ok === true && r.build === stack.hash, "/health reports the build hash of the bundle we just built", JSON.stringify(r));
  ok((await stack.api("/rooms", { k: "wrong" })).status === 403, "a wrong key is refused");
  const created = await stack.api("/rooms", { method: "POST", body: { name: room, cwd } });
  ok(created.status === 200 && created.data.room.name === room, "create a room through the Hub", JSON.stringify(created));

  // ── the Room DO over a real websocket (hibernation API)
  const owner = await open(`room=${room}&k=${key}&name=Ann`, "owner");
  const hello = await waitFor(owner.evs, m => m.type === "hello");
  ok(!!hello && hello.you.role === "owner" && hello.you.name === "Ann" && hello.room === room, "owner socket gets a hello frame with its role and room", JSON.stringify(hello && hello.you));
  ok(hello && hello.bridge === false, "…and sees that no bridge is connected yet");
  owner.send(JSON.stringify({ type: "say", text: "SCEN:ok first message" }));
  const sayEv = await waitFor(owner.evs, m => m.type === "say" && /first message/.test(m.text));
  ok(!!sayEv && sayEv.from === "Ann" && sayEv.role === "owner", "a say is accepted, stamped with the speaker and broadcast back");
  ok(!!(await waitFor(owner.evs, m => m.type === "sys" && /No bridge connected/.test(m.text))), "…and the room says there is no bridge, rather than hanging");

  // ── roles on the socket
  const inv = await stack.api(`/rooms/${room}/invites`, { method: "POST", body: { role: "viewer", name: "Vic" } });
  const viewer = await open(`k=${inv.data.token}`, "viewer"); const vh = await waitFor(viewer.evs, m => m.type === "hello");
  ok(vh && vh.you.role === "viewer" && vh.you.name === "Vic", "an invite token opens the room as that role with the name locked in", JSON.stringify(vh && vh.you));
  viewer.send(JSON.stringify({ type: "say", text: "viewers must not be able to speak" })); await sleep(500);
  ok(!owner.evs.some(m => m.type === "say" && /viewers must not/.test(m.text)), "a viewer's say is ignored by the Room");
  ok(owner.evs.some(m => m.type === "presence" && m.users.some(u => u.name === "Vic" && u.token)), "owners see presence with invite tokens…");
  ok(viewer.evs.filter(m => m.type === "presence").every(p => p.users.every(u => !("token" in u))), "…and a viewer's presence frames carry no tokens");

  // ── the bridge relay with the fake claude
  bridge = stack.startBridge({ only: [], claude: "fake" });
  ok(!!(await waitFor(owner.evs, m => m.type === "presence" && m.bridge === true, 30000)), "a real bridge connects and the room reports it online", bridge.output().slice(-600));
  owner.send(JSON.stringify({ type: "say", text: "SCEN:ok second message" }));
  const done = await waitFor(owner.evs, m => m.type === "done" && /ok model=/.test(m.text), 30000);
  ok(!!done, "a message sent to a room with a live bridge runs a turn end to end (browser -> Room DO -> bridge -> claude -> Room DO -> browser)", bridge.output().slice(-800));
  ok(!!(await waitFor(owner.evs, m => m.type === "tool" && m.name === "Bash")), "…with a tool card");
  ok(!!(await waitFor(viewer.evs, m => m.type === "done")), "…which the viewer also receives");

  // ── storage survives a reconnect (real Durable Object storage)
  owner.close(); await sleep(400);
  const again = await open(`room=${room}&k=${key}&name=Ann`, "owner again"); const h2 = await waitFor(again.evs, m => m.type === "hello");
  ok(h2 && h2.log.some(m => m.type === "say" && /first message/.test(m.text)) && h2.log.some(m => m.type === "done"), "a reconnecting socket gets the stored transcript in its hello", JSON.stringify(h2 && h2.log.map(m => m.type)));
  const hist = await fetch(`${url}/api/history?room=${room}&k=${key}`).then(r => r.json());
  ok(hist.ok && hist.items.length >= 3, "/api/history reads the same stored entries", JSON.stringify(hist).slice(0, 200));
  const md = await fetch(`${url}/api/export?room=${room}&k=${key}`).then(r => r.text());
  ok(md.includes("first message") && md.includes("**Ann**"), "/api/export renders the transcript as Markdown");

  // ── revocation closes the socket (4001) and kills the token
  const closed = new Promise(res => viewer.addEventListener("close", e => res(e.code)));
  const rv = await stack.api(`/revoke/${inv.data.token}`, { method: "POST" });
  ok(rv.status === 200, "revoke an invite");
  ok((await Promise.race([closed, sleep(5000).then(() => "timeout")])) === 4001, "…the viewer's live socket is closed with code 4001");
  ok((await stack.api("/whoami", { k: inv.data.token })).status === 403, "…and its token no longer resolves");

  // ── the bridge saw the room come and go through the Hub
  const del = await stack.api(`/rooms/${room}`, { method: "DELETE" });
  ok(del.status === 200, "delete the room");
  await sleep(800);
  ok(/closed/.test(bridge.output()), "the bridge heard the deletion over its Hub socket and closed the room", bridge.output().slice(-400));
  ok(!/ReferenceError|TypeError|Unhandled|SyntaxError/.test(bridge.output()), "the bridge logged no runtime errors");
} catch (e) { ok(false, "test harness threw: " + (e && e.stack || e)); if (bridge) console.log("--- bridge ---\n" + bridge.output().slice(-1500)); console.log("--- worker ---\n" + stack.log().slice(-1500)); }
await finish();
