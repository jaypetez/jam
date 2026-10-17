// Changing an invite's role in place, end to end against the LIVE Worker (run-tests.sh): who may do it, the open tab's
// reload, and the demotion reaching that person's queued work (Room outbox + a bridge that connects later). No real
// bridge runs here — a raw bridge socket (root key, role=bridge) stands in, so nothing ever executes.
import { httpBase, wsBase } from "./jam-url.mjs";
import { readFileSync } from "node:fs";
import path from "node:path"; import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const H = process.env.JAM_HOST || "jam.nullagency.io", RK = process.env.K || readFileSync(path.join(here, ".jam-key"), "utf8").trim();
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const api = async (p, k, o = {}) => { const r = await fetch(`${httpBase(H)}${p}${p.includes("?") ? "&" : "?"}k=${encodeURIComponent(k)}`, { ...o, headers: { "content-type": "application/json", ...(o.headers || {}) } }); let d = {}; try { d = await r.json(); } catch {} return { status: r.status, ...d }; };
const R1 = "test-role", R2 = "test-role2";
function sock(k, rm, extra = "", q = "") {
  const ws = new WebSocket(`${wsBase(H)}/ws?room=${encodeURIComponent(rm)}&k=${encodeURIComponent(k)}&name=qa${extra}${q}`); const ev = [];
  ws.onmessage = e => { try { ev.push(JSON.parse(e.data)); } catch {} };
  const open = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const closed = new Promise(res => ws.addEventListener("close", c => res(c.code)));
  return { ws, ev, open, closed, wait: async (f, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const x = ev.find(f); if (x) return x; await new Promise(r => setTimeout(r, 150)); } return null; } };
}
const role = (rm, t, to, k = RK, hdr = {}) => api(`/api/rooms/${rm}/invites/${encodeURIComponent(t)}`, k, { method: "POST", body: JSON.stringify({ role: to }), headers: hdr });
const socks = [];
try {
  for (const r of [R1, R2]) { await api(`/api/rooms/${r}`, RK, { method: "DELETE" }); await api("/api/rooms", RK, { method: "POST", body: JSON.stringify({ name: r, cwd: "/tmp/jam-" + r }) }); }
  const mint = async (rm, rl, name) => (await api(`/api/rooms/${rm}/invites`, RK, { method: "POST", body: JSON.stringify({ role: rl, name }) })).token;
  const drv = await mint(R1, "driver", "dee"), own = await mint(R1, "owner", "oz"), own2 = await mint(R2, "owner", "oy");
  ok(drv && own && own2, "minted driver + owner invites in two rooms");

  // ── who may change a role ──
  ok((await role(R1, own, "viewer", drv)).status === 403, "a driver can't change roles");
  ok((await role(R1, drv, "owner", own)).status === 403, "an owner-by-invite can't change roles in its own room");
  ok((await role(R2, own2, "viewer", own)).status === 403, "…or in another room");
  ok((await role(R1, drv, "admin")).status === 400, "unknown role → 400");
  ok((await role(R2, drv, "viewer")).status === 404, "an invite named under the wrong room → 404");
  ok((await role(R1, "__proto__", "viewer")).status === 404, "__proto__ isn't an invite");
  ok((await role(R1, drv, "driver")).changed === false, "same role → no change");
  ok((await api("/api/whoami?room=" + R1, own)).byInvite === true && (await api("/api/whoami?room=" + R1, RK)).byInvite === false, "/whoami says byInvite only for invite keys");

  // ── the open tab reloads with the new role ──
  const a = sock(drv, R1); socks.push(a); await a.open;
  ok((await a.wait(e => e.type === "hello"))?.you?.role === "driver", "driver tab connects as driver");
  const up = await role(R1, drv, "owner", RK, { "x-jam-scope": R1 }); // a spoofed scope header from outside is stripped, never honoured
  ok(up.ok && up.changed && up.reloaded, "host owner promotes driver → owner (spoofed x-jam-scope ignored)");
  ok(!!(await a.wait(e => e.type === "reload")), "the tab gets {type:reload}");
  { const cc = await Promise.race([a.closed, new Promise(r => setTimeout(() => r(-1), 20000))]); ok(cc === 4004, "…and closes with 4004 (got " + cc + ")"); }
  ok((await api("/api/whoami?room=" + R1, drv)).role === "owner", "/whoami now says owner");
  const b = sock(drv, R1, "2"); socks.push(b); await b.open;
  ok((await b.wait(e => e.type === "hello"))?.you?.role === "owner", "reconnect: hello.you.role is owner");

  // ── demotion takes the person's queued work with it (no bridge: the say sits in the Room outbox) ──
  b.ws.send(JSON.stringify({ type: "say", text: "queued while owner — must not run as owner after a demotion" }));
  const said = await b.wait(e => e.type === "say" && e.from === "dee");
  ok(said?.role === "owner", "the queued message was stamped owner");
  const down = await role(R1, drv, "driver"); ok(down.ok && down.changed, "demote owner → driver");
  const br = sock(RK, R1, "", "&role=bridge"); socks.push(br); await br.open; // a bridge that was down at demotion time
  const dm = await br.wait(e => e.type === "demote" && e.ids.includes(said?.id)), q = await br.wait(e => e.type === "say" && e.id === said?.id);
  ok(dm && dm.role === "driver" && dm.ids.includes(said?.id), "a bridge connecting later gets the demotion");
  ok(q?.role === "driver", "…and the outbox replays that message as driver");
  ok(br.ev.findIndex(e => e.type === "demote") < br.ev.findIndex(e => e.type === "say"), "…demotion arrives before the outbox");
  const gone = await role(R1, drv, "viewer"); ok(gone.ok && gone.changed, "demote driver → viewer");
  ok(!!(await br.wait(e => e.type === "demote" && e.role === "viewer")), "the live bridge gets the viewer demotion");
  const c = sock(RK, R1, "3"); socks.push(c); await c.open; const hc = await c.wait(e => e.type === "hello");
  ok(hc && !(hc.queue || []).some(x => x.id === said?.id) && (hc.status?.queue | 0) === 0, "a viewer's queued message is dropped from the Room queue");

  // ── revoke = demote to nothing ──
  const z = sock(own, R1, "4"); socks.push(z); await z.open; await z.wait(e => e.type === "hello");
  z.ws.send(JSON.stringify({ type: "say", text: "owner-invite queued, then revoked" }));
  const zs = await z.wait(e => e.type === "say" && e.from === "oz");
  const rv = await api(`/api/invites/${own}`, RK, { method: "DELETE" }); ok(rv.ok, "revoke the owner invite");
  ok(!!(await br.wait(e => e.type === "demote" && e.role === "viewer" && e.ids.includes(zs?.id))), "revoking sends the bridge a drop for their queued work");
} catch (e) { ok(false, "threw: " + e.message); }
finally {
  for (const s of socks) { try { s.ws.close(); } catch {} }
  for (const r of [R1, R2]) await api(`/api/rooms/${r}`, RK, { method: "DELETE" }).catch(() => {});
  console.log(fails ? `test-role: ${fails} failure(s)` : "test-role: all passed"); process.exit(fails ? 1 : 0);
}
