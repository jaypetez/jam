#!/usr/bin/env node
// e2e: the "Run commands on this machine" switch, through the REAL bridge -> env -> approve hook path (stub CLI, run-tests.sh).
//   JAM_ONLY=test-runlocal JAM_CLAUDE=<repo>/test-runlocal-claude-stub.mjs JAM_CATALOG=off node bridge.mjs
//   K=<owner key> JAM_HOST=<host> ROOM=test-runlocal node runlocal.test.mjs
const K = process.env.K, H = process.env.JAM_HOST || "jam.nullagency.io", ROOM = process.env.ROOM || "test-runlocal";
let fail = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };
const api = (p, body, method = "POST") => fetch(`https://${H}/api${p}${p.includes("?") ? "&" : "?"}k=${K}`, { method, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
const sock = async q => { const w = new WebSocket(`wss://${H}/ws?${q}`); await new Promise((res, rej) => { w.onopen = () => res(); w.onerror = () => rej(new Error("ws error")); }); const evs = []; w.onmessage = e => evs.push(JSON.parse(e.data)); return { w, evs, send: x => w.send(x) }; };
const waitFor = (evs, pred, ms) => new Promise(res => { const t0 = Date.now(); const iv = setInterval(() => { const hit = evs.find(pred); if (hit || Date.now() - t0 > ms) { clearInterval(iv); res(hit || null); } }, 250); });
const inv = await api(`/rooms/${ROOM}/invites`, { role: "driver", name: "Driver1" });
const tok = inv.invite?.token || inv.token;
const owner = await sock(`room=${ROOM}&k=${K}&name=Mike`), driver = await sock(`k=${tok}&name=Driver1`);
await new Promise(r => setTimeout(r, 2500));
const turn = async who => { const mark = who.evs.length; who.send(JSON.stringify({ type: "say", text: "probe" })); const d = await waitFor(who.evs, e => e.type === "done" && who.evs.indexOf(e) >= mark, 60000); return d ? d.text : ""; };
const codes = t => ({ node: +(/node=(\d+)/.exec(t) || [])[1], rm: +(/rm=(\d+)/.exec(t) || [])[1], ctl: +(/ctl=(\d+)/.exec(t) || [])[1], flag: (/flag=(\S+)/.exec(t) || [])[1], role: (/role=(\S+)/.exec(t) || [])[1] });

let t = await turn(driver), c = codes(t);
ok(c.role === "driver" && c.flag === "unset" && c.node === 2 && c.rm === 2, "flag off: the driver's risky commands need approval, no flag in env — " + t);
ok((await api(`/rooms/${ROOM}/settings`, { runLocal: true })).room?.runLocal === true, "owner turns the switch on");
await new Promise(r => setTimeout(r, 2500));
t = await turn(driver); c = codes(t);
ok(c.flag === "1" && c.node === 0 && c.rm === 0, "flag on: the driver's node / rm -rf run with no card — " + t);
ok(c.ctl === 2, "flag on: touching .jam-key is still gated — " + t);
ok((await api(`/rooms/${ROOM}/settings`, { model: "auto" })).room?.runLocal === true, "changing another setting doesn't turn it off");
await new Promise(r => setTimeout(r, 2500));
t = await turn(owner); c = codes(t);
ok(c.role === "owner" && c.flag === "unset", "an owner turn never gets the flag — " + t);
// a room whose directory contains jam's own code must never go card-free, even with the switch on
for (const cwd of ["/", process.env.HOME]) {
  ok((await api(`/rooms/${ROOM}/settings`, { cwd })).ok === true, "room directory set to " + cwd);
  await new Promise(r => setTimeout(r, 3500));
  t = await turn(driver); c = codes(t);
  ok(c.flag === "unset" && c.node === 2 && c.rm === 2, `cwd ${cwd}: switch ON but the commands still need approval — ` + t);
}
await api(`/rooms/${ROOM}/settings`, { cwd: "/tmp/jam-test-runlocal", runLocal: false });
await new Promise(r => setTimeout(r, 3500));
t = await turn(driver); c = codes(t);
ok(c.flag === "unset" && c.node === 2, "switch off again: cards are back on the next turn — " + t);
owner.w.close(); driver.w.close();
console.log(fail ? `\n${fail} runlocal FAILURES` : "\nrunlocal: pass"); process.exit(fail ? 1 : 0);

