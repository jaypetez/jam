// jam — shared Claude Code session rooms. Cloudflare Worker + two Durable Objects.
//   Hub  (singleton): room registry, invite tokens, bridge sockets, owner lobby sockets.
//   Room (per room):  transcript, user/bridge sockets, typing, approvals.
// The UI is base64-embedded at build time as B64 (see build.sh). The modules in inline-modules.txt (budget.mjs, worker-lib.mjs) are inlined
// ahead of this file with their `export` stripped, so ROLES, TIERS, roomName, token, cleanCatalog, parseNewRoom... below come from there.

const MAX_LOG = 5000;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const bad = (msg, status = 400) => json({ ok: false, error: msg }, status);

// ── tenants ("hosts"): other people run their own bridge, on their own Claude, against this hub. Tenant "" is the root
// (the deployment owner, env.JAM_KEY) and keeps the original ids; tenant T gets Hub "t:T" and Rooms "t:T:<room>" —
// roomName() strips ":" and tenant names are [a-z0-9], so no two tenants' ids can collide. These four helpers are the
// ONLY places a DO id is derived (check.sh fails the build on any other idFromName): an id built anywhere else would
// silently land a tenant in the root's data.
const TENANT_RE = /^[a-z0-9]{3,20}$/;
const RESERVED_TENANTS = new Set(["registry", "hub", "root", "admin", "api", "jam", "www", "null", "nullagency", "test"]);
const ROOM_CAP = 20, CODE_TTL = 7 * 86400e3;
const hubId = (env, tn) => env.HUB.idFromName(tn ? "t:" + tn : "hub");
const roomId = (env, tn, name) => env.ROOM.idFromName(tn ? "t:" + tn + ":" + name : name);
const registryId = env => env.REGISTRY.idFromName("registry");
const hubFor = (env, tn) => env.HUB.get(hubId(env, tn));
const roomFor = (env, tn, name) => env.ROOM.get(roomId(env, tn, name));
const registry = env => env.REGISTRY.get(registryId(env));
const tHdr = tn => ({ "x-jam-tenant": tn || "" });
async function sha256hex(s) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, "0")).join(""); }

/* ───────────────────────────── Hub ───────────────────────────── */
export class Hub {
  constructor(state, env) { this.state = state; this.env = env; this.rooms = null; this.tokens = null; this.revoked = null; this.sponsor = null; this.catalog = null; this.plan = null; this.spend = null; this.roomOrder = null; }
  async load() {
    if (this.rooms === null) { this.rooms = (await this.state.storage.get("rooms")) || {}; this.tokens = (await this.state.storage.get("tokens")) || {}; this.revoked = (await this.state.storage.get("revoked")) || {}; this.sponsor = (await this.state.storage.get("sponsor")) || null; this.catalog = (await this.state.storage.get("catalog")) || null; this.plan = (await this.state.storage.get("plan")) || null; this.spend = (await this.state.storage.get("spend")) || {}; this.roomOrder = (await this.state.storage.get("roomOrder")) || []; }
  }
  async save() { await this.state.storage.put("rooms", this.rooms); await this.state.storage.put("tokens", this.tokens); await this.state.storage.put("revoked", this.revoked); await this.state.storage.put("sponsor", this.sponsor); await this.state.storage.put("roomOrder", this.roomOrder); }
  publicRooms() { const all = Object.values(this.rooms); const order = this.roomOrder || []; const ordered = order.filter(n => all.find(r => r.name === n)).map(n => all.find(r => r.name === n)); const unordered = all.filter(r => !order.includes(r.name)); return [...ordered, ...unordered]; }
  bridges() { return this.state.getWebSockets("bridge"); }
  broadcast(obj, tag) { const s = JSON.stringify(obj); for (const ws of this.state.getWebSockets(tag)) { try { ws.send(s); } catch {} } }
  bridgeOnline() { return this.bridges().length > 0; }
  // best-effort close of any live socket holding a just-revoked/deleted token — one retry, never throws.
  // the durable revoked/tokens write already happened by the time this runs, so a false-negative here only
  // means an already-open tab stays connected until its next reconnect, not that revocation itself failed.
  // tell a driver's open tabs their budget changed (owner edit) — best effort, their next message re-checks anyway
  async pushBudget(t, tn) {
    const v = this.tokens[t]; if (!v || v.role !== "driver") return;
    try { await roomFor(this.env, tn, v.room).fetch("https://room/budget-push", { method: "POST", headers: tHdr(tn), body: JSON.stringify({ token: t, view: driverView(budgetStatus(v.budget, this.spend[t], this.plan)) }) }); } catch {}
  }
  async kickRoom(room, t, tn, reload) { // reload = the invite's new role: its tabs reconnect instead of showing "revoked"
    for (let i = 0; i < 2; i++) {
      try { const r = await roomFor(this.env, tn, room).fetch("https://room/kick", { method: "POST", headers: tHdr(tn), body: JSON.stringify({ token: t, reload: reload || null }) }); if (r.ok) return true; } catch {}
    }
    return false;
  }

  async fetch(req) {
    await this.load();
    const url = new URL(req.url);
    const p = url.pathname;
    // Which tenant this Hub serves comes from the caller (router / a Room DO), and is checked against this DO's own id:
    // a missing or wrong header can never make a tenant's hub act on the root's rooms, or the other way round.
    const tn = req.headers.get("x-jam-tenant") || "";
    if (!this.state.id.equals(hubId(this.env, tn))) return bad("tenant mismatch", 500);

    if (p === "/kick-all" && req.method === "POST" && !tn) return bad("never the root", 403);
    if (p === "/kick-all" && req.method === "POST") { // internal: the host was disabled — close every socket, here and in each of its rooms
      for (const ws of this.state.getWebSockets()) { try { ws.close(4003, "host disabled"); } catch {} }
      for (const name of Object.keys(this.rooms)) { try { await roomFor(this.env, tn, name).fetch("https://room/drop", { method: "POST", headers: tHdr(tn), body: JSON.stringify({ all: true }) }); } catch {} }
      return json({ ok: true });
    }
    if (p === "/wipe-all" && req.method === "POST") { // internal: a disabled host is being deleted — every room's transcript, then this hub's own storage
      if (!tn) return bad("never the root", 403);
      let failed = 0; // a room left unwiped would hand its transcript to whoever claims this host name next — so any failure fails the delete
      for (const name of Object.keys(this.rooms)) { try { const r = await roomFor(this.env, tn, name).fetch("https://room/wipe", { method: "POST", headers: tHdr(tn), body: JSON.stringify({ deleted: true }) }); if (!r.ok) failed++; } catch { failed++; } }
      if (failed) return bad(failed + " room(s) could not be wiped — try again", 500);
      for (const ws of this.state.getWebSockets()) { try { ws.close(4003, "host deleted"); } catch {} }
      await this.state.storage.deleteAll(); this.rooms = null; await this.load();
      return json({ ok: true });
    }

    // ── websocket: bridge or owner lobby ──
    if (p === "/hub") {
      if (req.headers.get("Upgrade") !== "websocket") return bad("expected websocket", 426);
      const role = url.searchParams.get("role") === "bridge" ? "bridge" : "lobby";
      const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server, [role]);
      server.serializeAttachment({ role, t: Date.now(), tenant: tn });
      server.send(JSON.stringify({ type: "rooms", rooms: this.publicRooms(), bridge: this.bridgeOnline() }));
      if (role === "bridge") this.broadcast({ type: "bridge", on: true }, "lobby");
      else this.broadcast({ type: "refresh" }, "bridge"); // a lobby opened: have the bridge re-read the model catalog (throttled bridge-side)
      return new Response(null, { status: 101, webSocket: client });
    }

    // ── internal + REST ──
    if (p === "/resolve") { // token → membership
      const tok = url.searchParams.get("t") || "";
      const t = this.tokens[tok];
      if (!t || this.revoked[tok]) return json({ ok: false }, 404);
      return json({ ok: true, room: t.room, name: t.name, role: t.role });
    }
    if (p === "/sponsor" && req.method === "GET") return json({ ok: true, sponsor: this.sponsor });
    if (p === "/sponsor" && req.method === "POST") { // instance-wide, not per-room — owner sets who's currently sponsoring this deployment
      const b = await req.json().catch(() => ({}));
      const sponsorName = String(b.name || "").trim().slice(0, 80);
      if (!sponsorName) { this.sponsor = null; await this.save(); return json({ ok: true, sponsor: null }); }
      const link = String(b.url || "").trim().slice(0, 300);
      this.sponsor = { name: sponsorName, url: link || null, updated: Date.now() };
      await this.save();
      return json({ ok: true, sponsor: this.sponsor });
    }
    let m;
    if (p === "/rooms" && req.method === "GET") return json({ ok: true, rooms: this.publicRooms(), bridge: this.bridgeOnline(), catalog: this.catalog });
    if (p === "/my-accessible-rooms" && req.method === "GET") {
      // returns rooms the user has access to: all rooms if owner, otherwise only the room(s) for which they have a valid invite token
      const url = new URL(req.url);
      const role = url.searchParams.get("role") || "viewer"; // passed from main worker after auth
      const room = url.searchParams.get("room") || "";
      if (role === "owner") return json({ ok: true, rooms: this.publicRooms(), bridge: this.bridgeOnline() });
      // non-owner: return only their room
      if (room && this.rooms[room]) {
        return json({ ok: true, rooms: [this.rooms[room]], bridge: this.bridgeOnline() });
      }
      return json({ ok: true, rooms: [], bridge: this.bridgeOnline() });
    }
    if (p === "/rooms" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      if (tn && Object.keys(this.rooms).length >= ROOM_CAP) return bad(`room limit reached (${ROOM_CAP} per host) — delete one first`, 403);
      const parsed = parseNewRoom(b, n => !!this.rooms[n]); if (parsed.error) return bad(parsed.error, parsed.status);
      const name = parsed.room.name, r = { ...parsed.room, created: Date.now(), updated: Date.now() };
      this.rooms[name] = r; await this.save();
      this.broadcast({ type: "room.change", op: "add", room: r });
      return json({ ok: true, room: r });
    }
    if (p === "/rooms/order" && req.method === "POST") { // sidebar order, hub-global; unknown names dropped, unlisted rooms keep their relative order at the tail
      const b = await req.json().catch(() => ({}));
      if (!Array.isArray(b.order)) return bad("order: array of room names");
      const order = orderRooms(b.order, this.roomOrder, this.rooms);
      this.roomOrder = order; await this.save();
      this.broadcast({ type: "room.change", op: "order", order });
      return json({ ok: true, order });
    }
    if ((m = /^\/rooms\/([^/]+)\/settings$/.exec(p)) && req.method === "POST") { // model / cwd of an existing room
      const name = roomName(m[1]); const r = this.rooms[name]; if (!r) return bad("no such room", 404);
      const b = await req.json().catch(() => ({}));
      const err = applyRoomSettings(r, b); if (err) return bad(err);
      r.updated = Date.now(); await this.save();
      this.broadcast({ type: "room.change", op: "update", room: r });
      return json({ ok: true, room: r });
    }
    if ((m = /^\/rooms\/([^/]+)\/activity$/.exec(p)) && req.method === "POST") { // internal only — a Room DO reporting a new chat message, for the unread badge.
      // Blocked from the public /api/* router (see worker fetch handler); reachable only via the direct env.HUB
      // Durable Object stub call Room.bumpActivity makes (env.HUB.get(id).fetch — bypasses the default fetch handler
      // entirely, unlike a real service binding, which would hit the same 404 below). Cosmetic data: kept in memory only, no storage write, so
      // it never contends with the durable rooms/tokens/revoked save every real CRUD op does; a DO eviction just
      // means the badge resyncs from the next message. Not persisted, not broadcast to the bridge — it doesn't care.
      const name = roomName(m[1]); const r = this.rooms[name]; if (!r) return bad("no such room", 404);
      const b = await req.json().catch(() => ({}));
      r.lastSeq = Math.max(r.lastSeq | 0, b.seq | 0); r.lastMsgAt = b.ts || Date.now();
      this.broadcast({ type: "room.change", op: "update", room: r }, "lobby");
      if (tn) { try { await registry(this.env).fetch("https://reg/touch", { method: "POST", body: JSON.stringify({ tenant: tn }) }); } catch {} } // per-host activity count, for the root's Hosts list (their DO usage bills to this deployment)
      return json({ ok: true });
    }
    if ((m = /^\/rooms\/([^/]+)\/presence$/.exec(p)) && req.method === "POST") { // internal only — a Room DO reporting its currently-connected users, for the lobby online indicator.
      // Same blocked-from-public-router / in-memory-only contract as /activity above.
      const name = roomName(m[1]); const r = this.rooms[name]; if (!r) return bad("no such room", 404);
      const b = await req.json().catch(() => ({}));
      r.online = Math.max(0, b.online | 0); r.onlineNames = Array.isArray(b.names) ? b.names.slice(0, 40).map(x => String(x).slice(0, 32)) : [];
      this.broadcast({ type: "room.change", op: "update", room: r }, "lobby");
      return json({ ok: true });
    }
    if ((m = /^\/rooms\/([^/]+)$/.exec(p)) && req.method === "DELETE") {
      const name = roomName(m[1]); if (!this.rooms[name]) return bad("no such room", 404);
      const r = this.rooms[name]; delete this.rooms[name]; this.roomOrder = (this.roomOrder || []).filter(n => n !== name);
      for (const [t, v] of Object.entries(this.tokens)) if (v.room === name) { delete this.tokens[t]; delete this.spend[t]; }
      await this.save(); await this.state.storage.put("spend", this.spend); this.broadcast({ type: "room.change", op: "remove", room: r });
      // forget the transcript too — otherwise a room created later with the same name inherits the old conversation
      try { await roomFor(this.env, tn, name).fetch("https://room/wipe", { method: "POST", headers: tHdr(tn), body: JSON.stringify({ deleted: true }) }); } catch {}
      return json({ ok: true });
    }
    if ((m = /^\/rooms\/([^/]+)\/rename$/.exec(p)) && req.method === "POST") {
      const from = roomName(m[1]); const b = await req.json().catch(() => ({})); const to = roomName(b.to);
      if (!this.rooms[from]) return bad("no such room", 404); if (!to) return bad("new name: a-z 0-9 - _"); if (this.rooms[to]) return bad("a room named " + to + " already exists");
      const old = this.rooms[from];
      // the destination is a fresh Room DO (import doesn't carry over msgSeq, only entries/agents/schedules/session/outbox),
      // so its message counter restarts at 0 — carrying the old lastSeq forward would either flood a false unread badge
      // (this device has never "seen" the new name) or freeze the badge for a long time once the fresh counter falls behind it
      const r = { ...old, name: to, cwd: String(b.cwd || old.cwd).slice(0, 300), updated: Date.now(), lastSeq: 0, lastMsgAt: null };
      const src = roomFor(this.env, tn, from), dst = roomFor(this.env, tn, to);
      const dump = await (await src.fetch("https://room/dump", { headers: tHdr(tn) })).json();
      const imp = await dst.fetch("https://room/import", { method: "POST", headers: tHdr(tn), body: JSON.stringify(dump) }); if (!imp.ok) return bad("import failed", 500);
      delete this.rooms[from]; this.rooms[to] = r; this.roomOrder = (this.roomOrder || []).map(n => n === from ? to : n);
      for (const v of Object.values(this.tokens)) if (v.room === from) v.room = to;
      await this.save();
      await src.fetch("https://room/wipe", { method: "POST", headers: tHdr(tn), body: JSON.stringify({ to }) });
      this.broadcast({ type: "room.change", op: "remove", room: old }); this.broadcast({ type: "room.change", op: "add", room: r });
      return json({ ok: true, room: r, entries: (dump.entries || []).length });
    }
    if ((m = /^\/rooms\/([^/]+)\/invites$/.exec(p))) {
      const room = roomName(m[1]); if (!this.rooms[room]) return bad("no such room", 404);
      if (req.method === "GET") {
        const list = Object.entries(this.tokens).filter(([, v]) => v.room === room).map(([t, v]) => { const st = v.role === "driver" ? budgetStatus(v.budget, this.spend[t], this.plan) : null; return { token: t, ...v, ...(st && st.limited ? { budgetState: st.state, budgetLeft: st.leftPct } : {}) }; });
        return json({ ok: true, invites: list });
      }
      if (req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        const role = ROLES.has(b.role) ? b.role : "driver";
        const name = String(b.name || "").trim().slice(0, 32) || null;
        const t = (tn ? tn + "." : "") + token(); this.tokens[t] = { room, name, role, created: Date.now(), by: String(b.by || "owner").slice(0, 32) }; // a host's invite names its hub ("T.<token>"), so the router knows where to resolve it
        await this.save();
        return json({ ok: true, token: t, invite: { token: t, ...this.tokens[t] } });
      }
    }
    if ((m = /^\/rooms\/([^/]+)\/invites\/([^/]+)$/.exec(p)) && req.method === "POST") { // change an invite's role in place; its open tabs reload with the new role
      if (req.headers.has("x-jam-scope")) return bad("only the host owner can change roles", 403); // an owner-by-invite can mint links but never re-role (or demote) another owner
      const room = roomName(m[1]), t = m[2]; const v = Object.hasOwn(this.tokens, t) ? this.tokens[t] : null; if (!v || v.room !== room || this.revoked[t]) return bad("no such invite", 404);
      const b = await req.json().catch(() => ({})); if (!ROLES.has(b.role)) return bad("role must be owner, driver or viewer");
      if (v.role === b.role) return json({ ok: true, invite: { token: t, ...v }, changed: false, reloaded: true });
      v.role = b.role; v.roleChanged = Date.now(); if (this.lastView) delete this.lastView[t]; await this.save();
      const reloaded = await this.kickRoom(v.room, t, tn, b.role); // also re-roles (or drops) that person's queued and marathon work — a demotion has to take their pending turns with it
      return json({ ok: true, invite: { token: t, ...v }, changed: true, reloaded });
    }
    // ── per-driver budgets (budget.mjs): owner reads/sets one invite's share of the host plan; Rooms check before a
    //    driver's message runs and report its cost after. /budget/* is internal (blocked in the public router). ──
    if ((m = /^\/invites\/([^/]+)\/budget$/.exec(p))) {
      const t = m[1]; const v = this.tokens[t]; if (!v) return bad("no such invite", 404);
      const scope = req.headers.get("x-jam-scope"); if (scope && v.room !== scope) return bad("scoped to " + scope, 403); // a room owner-by-invite manages budgets in their own room only
      if (v.role !== "driver") return bad("budgets apply to driver invites only");
      if (req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        if (b.share === null) delete v.budget;
        else {
          if ("share" in b && typeof b.share !== "number") return bad("share must be a number 0–100, or null for no limit");
          const share = Math.round("share" in b ? b.share : v.budget ? v.budget.share : NaN);
          if (!Number.isFinite(share) || share < 0 || share > 100) return bad("share must be 0–100, or null for no limit");
          v.budget = { share, downshift: "downshift" in b ? !!b.downshift : v.budget ? !!v.budget.downshift : true, updated: Date.now() };
        }
        await this.save(); await this.pushBudget(t, tn);
      } else if (req.method !== "GET") return bad("method not allowed", 405);
      return json({ ok: true, invite: { token: t, ...v }, status: budgetStatus(v.budget, this.spend[t], this.plan), spends: (this.spend[t] || []).slice(-25).reverse(), plan: this.plan ? { limits: this.plan.limits, ts: this.plan.ts } : null, light: this.catalog?.tiers?.light || null, lightLabel: (this.catalog?.models || []).find(x => x.id === this.catalog?.tiers?.light)?.label || null });
    }
    if (p === "/budget/check" && req.method === "POST") {
      const b = await req.json().catch(() => ({})); const v = this.tokens[b.t];
      if (!v || v.role !== "driver") return json({ ok: true, limited: false, state: "unlimited" });
      return json({ ok: true, ...budgetStatus(v.budget, this.spend[b.t], this.plan) });
    }
    if (p === "/budget/spend" && req.method === "POST") {
      const b = await req.json().catch(() => ({})); const v = this.tokens[b.t]; const cost = Number(b.cost);
      if (!v || !(cost > 0)) return json({ ok: true, skipped: true });
      const cut = Date.now() - 8 * 86400e3;
      this.spend[b.t] = rollupSpend([...(this.spend[b.t] || []).filter(x => x.ts >= cut), { ts: Date.now(), cost: Math.round(cost * 10000) / 10000, room: roomName(b.room), model: String(b.model || "").slice(0, 60) }], 400);
      await this.state.storage.put("spend", this.spend);
      return json({ ok: true, ...budgetStatus(v.budget, this.spend[b.t], this.plan) });
    }
    if ((m = /^\/invites\/([^/]+)$/.exec(p)) && req.method === "DELETE") {
      const t = m[1]; const v = this.tokens[t]; if (!v) return bad("no such invite", 404);
      delete this.tokens[t]; if (this.spend[t]) { delete this.spend[t]; await this.state.storage.put("spend", this.spend); } await this.save();
      // kick live sockets using this token — the invite record is already gone either way, so a failed
      // kick just means a currently-open tab stays connected until it reconnects; surface that to the caller
      const kicked = await this.kickRoom(v.room, t, tn);
      return json({ ok: true, kicked });
    }
    if ((m = /^\/revoke\/([^/]+)$/.exec(p)) && req.method === "POST") {
      const t = m[1]; const v = this.tokens[t]; if (!v) return bad("no such token", 404);
      this.revoked[t] = true; await this.save(); // durable revocation happens first and unconditionally —
      // a failed kick below must never look like a failed revoke; the token is dead for any *new* connection either way
      const kicked = await this.kickRoom(v.room, t, tn);
      return json({ ok: true, kicked });
    }
    return bad("not found", 404);
  }

  async webSocketMessage(ws, raw) {
    await this.load();
    let m; try { m = JSON.parse(raw); } catch { return; }
    const who = ws.deserializeAttachment() || {};
    if (who.role === "bridge" && m.type === "ping") { try { ws.send(JSON.stringify({ type: "pong" })); } catch {} }
    if (who.role === "bridge" && m.type === "catalog") { const c = cleanCatalog(m); if (c && c.ts !== this.catalog?.ts) { this.catalog = c; await this.state.storage.put("catalog", c); this.broadcast({ type: "catalog", ...c }, "lobby"); } }
    if (who.role === "bridge" && m.type === "plan") { // host plan + learned $→plan rate, for per-driver budgets
      const pl = cleanPlan(m); if (!pl || pl.ts === this.plan?.ts) return;
      this.plan = pl; await this.state.storage.put("plan", pl);
      this.lastView = this.lastView || {}; // the host drawing the plan down or a window resetting changes a driver's allowance: tell their tabs (only when their view actually changed)
      for (const [t, v] of Object.entries(this.tokens)) if (v.role === "driver" && v.budget) { const sig = JSON.stringify(driverView(budgetStatus(v.budget, this.spend[t], this.plan))); if (this.lastView[t] !== sig) { this.lastView[t] = sig; await this.pushBudget(t, who.tenant || ""); } }
    }
    if (who.role === "lobby" && m.type === "rooms.list") { try { ws.send(JSON.stringify({ type: "rooms", rooms: this.publicRooms(), bridge: this.bridgeOnline() })); } catch {} }
  }
  async webSocketClose(ws, code, reason) {
    try { ws.close(code || 1000, reason || ""); } catch {} // a client-initiated close needs our close frame back or the browser hangs in CLOSING
    const who = ws.deserializeAttachment() || {}; if (who.role === "bridge") this.broadcast({ type: "bridge", on: this.bridgeOnline() }, "lobby");
  }
  async webSocketError(ws) { return this.webSocketClose(ws); }
}

/* ───────────────────────────── Room ───────────────────────────── */
// Bridge state the Room mirrors (re-sent by the bridge on every connect, but a reload must show it before then) and their empty values.
// saveMeta() and load() both walk THIS list: hand-written save/load lines drifted twice — `commands` was saved but never read back, then an
// inline // comment swallowed six restores, so every Durable Object eviction blanked them (2026-10-17). room-meta.test.mjs round-trips it.
const ROOM_MIRRORS = () => ({ agents: [], commands: null, schedules: [], usage: null, auth: null, catalog: null, ctx: null, session: null });
export class Room {
  constructor(state, env) {
    this.state = state; this.env = env;
    this.log = null;
    this.status = { running: false, queue: 0, current: null };
    this.agents = [];
    this.schedules = [];
    this.usage = null; // plan usage (5-hour / weekly limits) of the bridge host's Claude account — sent to owners only
    this.catalog = null; // live model list, windows, effort levels, prices (bridge reads the Models API + pricing page)
    this.ctx = null;     // { now, max } context after the last turn, so a reload shows the tokens meter right away
    this.session = null;
    this.pending = {};   // approval id -> { entry, waiters: [resolve] }
    this.outbox = [];    // say entries not yet picked up by a bridge (replayed on bridge reconnect)
    this.colors = {};    // user → color, from the bridge; sent in hello so every tab agrees
    this.costTotal = 0;  // lifetime $ for this room: every done.cost ever, durable in meta (the log itself is capped at MAX_LOG, so a client can't rebuild this)
    this.bridgeDownAt = null;
    this.turnTok = {};   // say id → invite token of the driver who sent it, so the turn's cost lands on that driver's budget (never broadcast)
    this.partial = null;   // { id, text } of the turn currently streaming — handed to a browser that (re)connects mid-turn // set when the last bridge socket closes — lets a quick reconnect (deploy, brief network hiccup) stay silent instead of spamming the transcript
  }
  async load() {
    if (this.log !== null) return;
    const meta = (await this.state.storage.get("meta")) || {};
    this.seq = meta.seq || 0;
    this.msgSeq = meta.msgSeq || 0; // counts only say/done/error entries (real messages) — this.seq counts every tool card too, so the unread badge can't use it
    const legacy = await this.state.storage.get("log");
    if (legacy) { // migrate the single-key log into per-entry keys
      for (const e of legacy) { this.seq++; await this.state.storage.put(this.key(this.seq), e); }
      await this.state.storage.delete("log"); meta.seq = this.seq; await this.state.storage.put("meta", meta);
    }
    const m = await this.state.storage.list({ prefix: "e:", reverse: true, limit: 400 });
    this.log = [...m.entries()].map(([k, v]) => ({ ...v, _s: parseInt(k.slice(2), 10) })).reverse();
    // meta.seq has the same every-10th-push durability as msgSeq below. Waking from eviction with a stale seq made
    // push() reuse keys and overwrite up to 9 newer entries (tool_results vanished → tool cards spun forever,
    // 2026-09-15). The highest stored key is the true high-water mark.
    if (this.log.length) this.seq = Math.max(this.seq, this.log[this.log.length - 1]._s);
    // meta.msgSeq is only durable every 10th push (see saveMeta call sites) — a DO evicted between saves would
    // otherwise replay up to 9 already-bumped message ordinals and Math.max on the Hub side would swallow them.
    // The loaded log tail always has the true high-water mark, so take whichever is higher.
    for (const e of this.log) if (e._m > this.msgSeq) this.msgSeq = e._m;
    this.status = meta.status || this.status; for (const [k, d] of Object.entries(ROOM_MIRRORS())) this[k] = meta[k] || d; // every bridge mirror, from the same list saveMeta writes
    for (const e of Object.values(meta.pending || {})) this.pending[e.id] = { entry: e, waiters: [] }; // survive DO eviction
    this.outbox = meta.outbox || [];
    this.colors = meta.colors || {};
    this.turnTok = meta.turnTok || {};
    this.sayTok = meta.sayTok || {}; this.demotes = meta.demotes || []; // say id → sender's invite token (any role, never broadcast); recent demotions, re-sent to every bridge that connects
    if (!this.bridges().length) { this.status.running = false; this.status.current = null; }
    if (typeof meta.costTotal === "number") this.costTotal = meta.costTotal;
    else { // first load after this field shipped: backfill from every stored entry (whatever is still within MAX_LOG retention), then make it durable
      let sum = 0; const all = await this.state.storage.list({ prefix: "e:" });
      for (const v of all.values()) if (v && v.type === "done" && v.cost) sum += Number(v.cost) || 0;
      this.costTotal = sum; await this.saveMeta();
    }
  }
  async saveMeta() {
    const pending = {}; for (const [id, p] of Object.entries(this.pending)) pending[id] = p.entry;
    await this.state.storage.put("meta", { status: this.status, ...Object.fromEntries(Object.keys(ROOM_MIRRORS()).map(k => [k, this[k] ?? null])), pending, outbox: this.outbox.slice(-20), seq: this.seq, msgSeq: this.msgSeq, colors: this.colors, costTotal: this.costTotal, turnTok: Object.fromEntries(Object.entries(this.turnTok).slice(-100)), sayTok: Object.fromEntries(Object.entries(this.sayTok || {}).slice(-300)), demotes: (this.demotes || []).filter(d => Date.now() - d.ts < 7 * 86400e3).slice(-20) });
  }
  key(n) { return "e:" + String(n).padStart(12, "0"); }

  bridges() { return this.state.getWebSockets("bridge"); }
  users() { return this.state.getWebSockets("user"); }
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  broadcast(obj, tag) { const s = JSON.stringify(obj); for (const ws of (tag ? this.state.getWebSockets(tag) : this.state.getWebSockets())) { try { ws.send(s); } catch {} } }
  toOwners(s) { for (const u of this.users()) if ((u.deserializeAttachment() || {}).role2 === "owner") { try { u.send(s); } catch {} } } // `s` is an already-serialized frame: host-account details and drivers' budget notes go to owners only
  presence(excludeWs) {
    const allUsers = this.users().filter(w => w !== excludeWs).map(w => { const a = w.deserializeAttachment() || {}; return { name: a.name, role: a.role2, token: a.token || "" }; });
    const bridgeOnline = this.bridges().length > 0;
    for (const ws of this.users().filter(w => w !== excludeWs)) {
      const receiver = ws.deserializeAttachment() || {};
      const isOwner = receiver.role2 === "owner";
      const users = allUsers.map(u => ({ name: u.name, role: u.role, ...(isOwner ? { token: u.token } : {}) }));
      this.send(ws, { type: "presence", users, bridge: bridgeOnline });
    }
  }
  queueList() { return this.outbox.map(e => ({ id: e.id, from: e.from, text: String(e.text || "").slice(0, 120), ts: e.ts })); }
  async push(entry) {
    this.seq++; entry._s = this.seq;
    if (entry.type === "say" || entry.type === "done" || entry.type === "error" || entry.type === "approval") { this.msgSeq++; entry._m = this.msgSeq; } // message-only ordinal, for the unread badge — this.seq also counts tool cards
    this.log.push(entry); if (this.log.length > 400) this.log = this.log.slice(-400);
    await this.state.storage.put(this.key(this.seq), entry);
    if (this.seq > MAX_LOG) await this.state.storage.delete(this.key(this.seq - MAX_LOG));
    if (this.seq % 10 === 0) await this.saveMeta();
  }
  async clearLog() {
    this.log = []; let m;
    while ((m = await this.state.storage.list({ prefix: "e:", limit: 128 })).size) await this.state.storage.delete([...m.keys()]);
  }
  pendingList() { return Object.values(this.pending).map(p => p.entry); }
  // tells the Hub a real chat message (not a tool card) landed here, so the room list can show an unread badge.
  // best-effort: callers place this after anything that must reach the bridge in order, then await it just so
  // the subrequest isn't cancelled the instant the handler returns — a failed call just means the badge lags
  // until the next message, never worth failing the turn over.
  // per-driver budgets live on the Hub (with the invite); a Room asks before a driver's message runs and reports its cost after
  // every Hub call names the tenant this room belongs to — taken from the socket attachment the router set, never stored
  hubPost(tn, path, body) { return hubFor(this.env, tn).fetch("https://hub" + path, { method: "POST", headers: tHdr(tn), body: JSON.stringify(body) }); }
  async budget(path, body, tn) {
    try { const r = await this.hubPost(tn, "/budget/" + path, body); return r.ok ? await r.json() : null; } catch { return null; }
  }
  sendToToken(t, obj) { for (const u of this.users()) if ((u.deserializeAttachment() || {}).token === t) this.send(u, obj); }
  async bumpActivity(room, tn) {
    if (!room) return;
    try { await this.hubPost(tn, "/rooms/" + encodeURIComponent(room) + "/activity", { seq: this.msgSeq, ts: Date.now() }); } catch {}
  }
  // tells the Hub who's currently connected here, so the lobby can show an online indicator per room without
  // opening it. Same best-effort, in-memory-only contract as bumpActivity — a failed call just means the
  // indicator lags until the next connect/disconnect.
  async reportPresence(room, tn) {
    if (!room) return;
    const names = [...new Set(this.users().map(w => (w.deserializeAttachment() || {}).name).filter(Boolean))];
    try { await this.hubPost(tn, "/rooms/" + encodeURIComponent(room) + "/presence", { online: names.length, names }); } catch {}
  }

  async fetch(req) {
    await this.load();
    const url = new URL(req.url); const p = url.pathname;

    if (p === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return bad("expected websocket", 426);
      const role = req.headers.get("x-jam-role");            // owner | driver | viewer | bridge
      const name = (req.headers.get("x-jam-name") || "anon").slice(0, 32);
      const tok = req.headers.get("x-jam-token") || "";
      const room = req.headers.get("x-jam-room") || "";
      const tn = req.headers.get("x-jam-tenant") || "";
      if (!this.state.id.equals(roomId(this.env, tn, room))) return bad("tenant mismatch", 500); // the tenant on the socket is what every later Hub callback trusts
      if (role === "screen") { // live browser view: frames in, fanned out to people, never stored — no hello, no presence
        const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
        this.state.acceptWebSocket(server, ["screen"]); server.serializeAttachment({ role2: "screen", room, tenant: tn, t: Date.now() });
        return new Response(null, { status: 101, webSocket: client });
      }
      if (tok && this.reroled && this.reroled[tok] >= (+req.headers.get("x-jam-authed") || 0)) return new Response("role changed, reconnect", { status: 409 }); // authed with the old role a moment before a role change
      const tag = role === "bridge" ? "bridge" : "user";
      const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server, [tag]);
      server.serializeAttachment({ name, role2: role, token: tok, room, tenant: tn, t: Date.now() });
      this.send(server, { type: "hello", you: { name, role }, room, log: this.log.slice(-400), status: this.status, bridge: this.bridges().length > 0, agents: this.agents, commands: this.commands || null, schedules: this.schedules, usage: role === "owner" ? this.usage : null, auth: role === "owner" ? this.auth : null, catalog: this.catalog, ctx: this.ctx, session: this.session, approvals: this.pendingList(), queue: this.queueList(), seq: this.seq, msgSeq: this.msgSeq, roomCost: this.costTotal, build: typeof BUILD === "string" ? BUILD : null, partial: this.partial, colors: this.colors });
      if (role !== "bridge" && this.screen && Date.now() - this.screen.ts < 15000) this.send(server, this.screen); // joined mid-run: show the live view's latest frame right away
      if (role === "driver" && tok) { const st = await this.budget("check", { t: tok }, tn); if (st && st.limited) this.send(server, { type: "budget", ...driverView(st) }); }
      if (role === "bridge") {
        // only worth a chat line if it was down long enough for a person to notice — a deploy or a brief
        // network hiccup reconnects in a couple of seconds and shouldn't clutter the transcript
        if (this.bridgeDownAt && Date.now() - this.bridgeDownAt > 8000) this.broadcast({ type: "sys", text: "bridge back online after " + Math.round((Date.now() - this.bridgeDownAt) / 1000) + "s", ts: Date.now() }, "user");
        this.bridgeDownAt = null;
        for (const d of this.demotes || []) this.send(server, d); // before the outbox: a bridge that was down when someone was demoted still re-roles its persisted queue
        for (const e of this.outbox) this.send(server, e);
      }
      this.presence();
      if (role !== "bridge") this.broadcast({ type: "refresh" }, "bridge"); // every open/reload re-reads plan usage + the model catalog (throttled bridge-side)
      await this.reportPresence(room, tn);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (p === "/history") { // entries before a seq, oldest→newest
      const before = parseInt(url.searchParams.get("before") || "0", 10) || this.seq + 1;
      const m = await this.state.storage.list({ prefix: "e:", end: this.key(before), reverse: true, limit: 200 });
      const items = [...m.entries()].map(([k, v]) => ({ ...v, _s: parseInt(k.slice(2), 10) })).reverse();
      return json({ ok: true, items, more: items.length === 200 });
    }
    if (p === "/export") { // whole stored transcript as markdown
      const m = await this.state.storage.list({ prefix: "e:" });
      const room = req.headers.get("x-jam-room") || "room"; const out = [`# jam #${room} — transcript`, `_exported ${new Date().toISOString()}_`, ""];
      const t = x => new Date(x || 0).toISOString().replace("T", " ").slice(0, 16);
      for (const e of m.values()) {
        if (e.type === "say") out.push(`**${e.from}** · ${t(e.ts)}`, "", e.text || "", ...(e.attachments || []).map(a => `- 📎 ${a.name}`), "");
        else if (e.type === "done") out.push(`**Claude** · ${t(e.ts)}${e.cost ? ` · ${Number(e.cost) < 0.005 ? "<$0.01" : "$" + Number(e.cost).toFixed(2)}` : ""}`, "", e.text || "", "");
        else if (e.type === "error") out.push(`> ⚠️ ${e.text || "error"}`, "");
        else if (e.type === "tool") out.push(`> 🔧 \`${e.name}\` ${e.summary || ""}`);
        else if (e.type === "approval") out.push(`> ⏸ approval ${e.state}${e.by ? " by " + e.by : ""}: \`${(e.summary || "").split("\n")[0].slice(0, 200)}\``, "");
      }
      return new Response(out.join("\n"), { headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="jam-${room}.md"` } });
    }
    if (p === "/dump") { // everything, for rename/copy
      const m = await this.state.storage.list({ prefix: "e:" });
      return json({ entries: [...m.values()], agents: this.agents, schedules: this.schedules, session: this.session, outbox: this.outbox, costTotal: this.costTotal, turnTok: this.turnTok });
    }
    if (p === "/import" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      for (const e of b.entries || []) { this.seq++; const { _s, _m, ...rest } = e; await this.state.storage.put(this.key(this.seq), rest); } // strip both ordinals — this DO's own seq/msgSeq restart at 0, so a carried-over _m would claim positions this room's counter hasn't reached yet
      this.agents = b.agents || this.agents; this.schedules = b.schedules || this.schedules; this.outbox = [...this.outbox, ...(b.outbox || [])]; this.turnTok = { ...this.turnTok, ...(b.turnTok && typeof b.turnTok === "object" ? b.turnTok : {}) };
      this.costTotal += typeof b.costTotal === "number" ? b.costTotal : (b.entries || []).reduce((s, e) => s + (e && e.type === "done" && e.cost ? Number(e.cost) || 0 : 0), 0); // a rename carries the source room's lifetime total, including turns that had already fallen off its log
      await this.saveMeta();
      const m = await this.state.storage.list({ prefix: "e:", reverse: true, limit: 400 });
      this.log = [...m.entries()].map(([k, v]) => ({ ...v, _s: parseInt(k.slice(2), 10) })).reverse();
      return json({ ok: true, seq: this.seq });
    }
    if (p === "/wipe" && req.method === "POST") { // after a rename: send everyone to the new room, forget everything here
      const { to, deleted } = await req.json().catch(() => ({}));
      if (to) this.broadcast({ type: "moved", to }, "user"); else if (deleted) this.broadcast({ type: "gone" }, "user");
      for (const ws of this.state.getWebSockets()) { try { ws.close(4002, to ? "moved" : "deleted"); } catch {} }
      await this.clearLog(); this.pending = {}; this.outbox = []; this.session = null; this.agents = []; this.schedules = []; this.status = { running: false, queue: 0, current: null }; this.seq = 0; this.msgSeq = 0; this.partial = null; this.costTotal = 0; this.ctx = null; this.usage = null; this.turnTok = {}; this.sayTok = {}; this.demotes = []; this.reroled = {};
      await this.state.storage.delete("meta");
      return json({ ok: true });
    }
    if (p === "/drop" && req.method === "POST") { // owner tool + test hook: close every browser socket the way a recycled DO would; tabs reconnect on their own
      const { all } = await req.json().catch(() => ({})); // all: the host was disabled — bridge and screen sockets too; their reconnect fails auth
      let n = 0; for (const ws of all ? this.state.getWebSockets() : this.users()) { try { ws.close(all ? 4003 : 1012, all ? "host disabled" : "service restart"); n++; } catch {} }
      return json({ ok: true, closed: n });
    }
    if (p === "/budget-push" && req.method === "POST") { const b = await req.json().catch(() => ({})); if (b.token) this.sendToToken(b.token, { type: "budget", ...(b.view || { limited: false }) }); return json({ ok: true }); }
    if (p === "/kick" && req.method === "POST") {
      const { token: t, reload } = await req.json();
      this.reroled = this.reroled || {}; this.reroled[t] = Date.now(); // a socket the router authed before this moment carries the old role: refused on arrival
      for (const ws of this.users()) { const a = ws.deserializeAttachment() || {}; if (a.token && a.token === t) { this.send(ws, { type: reload ? "reload" : "kicked" }); try { ws.close(reload ? 4004 : 4001, reload ? "role changed" : "revoked"); } catch {} } }
      { // demoted (or revoked): their queued messages lose the old rights — re-stamped down, or dropped for a viewer/revoke — and the bridge does the same to its queue, marathon chain, pause and running turn
        const role = ROLES.has(reload) ? reload : "viewer", rank = { viewer: 0, driver: 1, owner: 2 };
        const ids = Object.keys(this.sayTok || {}).filter(id => this.sayTok[id] === t);
        if (ids.length) {
          const idset = new Set(ids), n0 = this.outbox.length;
          this.outbox = this.outbox.filter(e => !(idset.has(e.id) && role === "viewer")).map(e => idset.has(e.id) && rank[e.role] > rank[role] ? { ...e, role } : e);
          this.status.queue = Math.max(0, this.status.queue - (n0 - this.outbox.length));
          const d = { type: "demote", ids, role, ts: Date.now() }; this.demotes = [...(this.demotes || []), d].slice(-20); await this.saveMeta();
          for (const w of this.bridges()) this.send(w, d);
          this.broadcast({ type: "status", ...this.status }, "user"); this.broadcast({ type: "queue", items: this.queueList() }, "user");
        }
      }
      // presence must exclude the just-closed token; state.getWebSockets() may not have dropped it yet
      const allUsers = this.users().map(w => { const a = w.deserializeAttachment() || {}; return { name: a.name, role: a.role2, token: a.token || "" }; }).filter(u => u.token !== t);
      const bridgeOnline = this.bridges().length > 0;
      for (const ws of this.users()) { const receiver = ws.deserializeAttachment() || {}; const isOwner = receiver.role2 === "owner"; const users = allUsers.map(u => ({ name: u.name, role: u.role, ...(isOwner ? { token: u.token } : {}) })); this.send(ws, { type: "presence", users, bridge: bridgeOnline }); }
      const a0 = this.users()[0]?.deserializeAttachment() || {};
      await this.reportPresence(a0.room || "", a0.tenant || "");
      return json({ ok: true });
    }
    // approvals, called by the bridge-side hook
    if (p === "/approve" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const id = crypto.randomUUID();
      const entry = { type: "approval", id, from: String(b.from || "?").slice(0, 32), tool: String(b.tool || "?").slice(0, 40), summary: String(b.summary || "").slice(0, 2000), detail: String(b.detail || "").slice(0, 6000), ts: Date.now(), state: "pending" };
      this.pending[id] = { entry, waiters: [] }; await this.saveMeta();
      await this.push(entry);
      this.broadcast(entry, "user");
      if (!this.users().some(w => (w.deserializeAttachment() || {}).role2 === "owner")) this.broadcast({ type: "sys", text: "waiting for an owner to approve — none online right now", ts: Date.now() }, "user");
      return json({ ok: true, id });
    }
    let m;
    if ((m = /^\/approve\/([^/]+)$/.exec(p)) && req.method === "GET") {
      const pe = this.pending[m[1]];
      if (!pe) { const done = this.log.slice().reverse().find(e => e.type === "approval" && e.id === m[1]); return json(done ? { ok: true, state: done.state, by: done.by } : { ok: false }, done ? 200 : 404); }
      const r = await new Promise(res => { pe.waiters.push(res); setTimeout(() => res(null), 25000); });
      return json(r ? { ok: true, state: r.state, by: r.by } : { ok: true, state: "pending" });
    }
    return bad("not found", 404);
  }

  async decide(id, state, by) {
    const pe = this.pending[id]; if (!pe) return;
    delete this.pending[id];
    const e = { ...pe.entry, state, by, decided: Date.now() };
    await this.push(e); await this.saveMeta();
    this.broadcast(e, "user");
    for (const w of pe.waiters) w({ state, by });
  }

  async webSocketMessage(ws, raw) {
    await this.load();
    let m; try { m = JSON.parse(raw); } catch { return; }
    const who = ws.deserializeAttachment() || {};
    const role = who.role2;
    if (role === "screen") {
      if (m.type !== "screen") return;
      const f = { type: "screen", sid: String(m.sid || "").slice(0, 60), end: !!m.end, data: typeof m.data === "string" && m.data.length < 900000 ? m.data : null, label: String(m.label || "").slice(0, 160), url: String(m.url || "").slice(0, 300), ts: Date.now() };
      if (f.end) this.screen = null; else if (f.data) this.screen = f; else if (this.screen && this.screen.sid === f.sid) this.screen = { ...this.screen, label: f.label, url: f.url, ts: f.ts };
      this.broadcast(f, "user"); return;
    }

    if (role === "owner" || role === "driver" || role === "viewer") {
      const canDrive = role !== "viewer";
      if (m.type === "upload" && canDrive) {
        const b = this.bridges();
        if (!b.length) { this.send(ws, { type: "upload_error", id: m.id, text: "no bridge connected" }); return; }
        for (const w of b) this.send(w, { type: "upload", id: String(m.id).slice(0, 40), name: String(m.name || "file").slice(0, 120), mime: String(m.mime || "").slice(0, 80), seq: m.seq | 0, total: m.total | 0, data: typeof m.data === "string" ? m.data : "", from: who.name });
        return;
      }
      if (m.type === "say" && canDrive && typeof m.text === "string" && (m.text.trim() || (Array.isArray(m.attachments) && m.attachments.length))) {
        let budgetFlag = null; const isCompact = /^\/compact\b/i.test(m.text.trim());
        if (role === "driver" && who.token) {
          const st = await this.budget("check", { t: who.token }, who.tenant || "");
          if (!st) console.warn("budget check unavailable — letting", who.name, "through"); // fail open: a Hub hiccup shouldn't lock drivers out
          const live = new Set([...this.outbox.map(e => e.id), this.status.current].filter(Boolean));
          for (const id of Object.keys(this.turnTok)) if (!live.has(id)) delete this.turnTok[id];
          // spend is only known when a turn ends, so a limited driver gets one live message at a time — otherwise twenty
          // queued messages all pass the check against the same, not-yet-charged total
          const busy = st && st.limited && !isCompact && Object.values(this.turnTok).includes(who.token);
          if (st && (st.state === "blocked" || st.state === "paused" || busy)) { // not queued: tell the sender (their tab shows it with a local refill time)
            this.send(ws, { type: "budget", ...driverView(st), denied: busy && st.state !== "blocked" && st.state !== "paused" ? "busy" : true, text: m.text.slice(0, 20000) });
            if (!busy) {
              this.noted = this.noted || {}; // ...and quietly tell owners, at most once a minute per driver
              if (!(Date.now() - (this.noted[who.token] || 0) < 60000)) {
                this.noted[who.token] = Date.now();
                const note = JSON.stringify({ type: "sys", text: `${who.name}'s message didn't run: their budget is ${st.state === "paused" ? "paused" : "used up"}. Change it from their invite in the sidebar.`, ts: Date.now() });
                this.toOwners(note);
              }
            }
            return;
          }
          if (st && st.state === "downshift") budgetFlag = "downshift";
        }
        const attachments = (Array.isArray(m.attachments) ? m.attachments : []).slice(0, 6).map(a => ({ name: String(a.name || "file").slice(0, 120), path: String(a.path || "").slice(0, 400), thumb: typeof a.thumb === "string" && a.thumb.startsWith("data:image/") && a.thumb.length < 60000 ? a.thumb : null }));
        const entry = { type: "say", id: crypto.randomUUID(), from: who.name, role, text: m.text.slice(0, 20000), ts: Date.now(), ...(attachments.length ? { attachments } : {}), ...(budgetFlag ? { budget: budgetFlag } : {}) };
        if (who.token) this.sayTok[entry.id] = who.token; // so a later demotion can find this message, its marathon continuations and any pause it caused
        if (role === "driver" && who.token) this.turnTok[entry.id] = (isCompact ? "c:" : "") + who.token; // "c:" = charged if it costs, but never counts as the driver's live message
        const seen = { ...entry }; delete seen.budget; // the bridge needs the flag; nobody in the room needs to see a driver is near their budget
        await this.push(seen);
        this.status.queue++; this.outbox.push(entry); await this.saveMeta();
        this.broadcast(seen, "user");
        this.broadcast({ type: "status", ...this.status }, "user"); this.broadcast({ type: "queue", items: this.queueList() }, "user");
        const b = this.bridges();
        if (!b.length) this.broadcast({ type: "sys", text: "No bridge connected. Start the bridge on the host machine.", ts: Date.now() }, "user");
        for (const w of b) this.send(w, entry);
        await this.bumpActivity(who.room, who.tenant || ""); // fan-out above is already synchronous, so ordering is safe; still awaited so the runtime doesn't cancel the subrequest the instant this handler returns
      } else if (m.type === "unqueue" && canDrive && typeof m.id === "string") {
        const e = this.outbox.find(x => x.id === m.id); if (!e) return;
        if (e.from !== who.name && role !== "owner") return;
        this.outbox = this.outbox.filter(x => x.id !== m.id); delete this.turnTok[m.id]; this.status.queue = Math.max(0, this.status.queue - 1); await this.saveMeta();
        for (const w of this.bridges()) this.send(w, { type: "unqueue", id: m.id });
        this.broadcast({ type: "status", ...this.status }, "user"); this.broadcast({ type: "queue", items: this.queueList() }, "user");
        this.broadcast({ type: "sys", text: `${who.name} cancelled a queued message`, ts: Date.now() }, "user");
      } else if (m.type === "browser-click" && canDrive) {
        const b = this.bridges();
        if (!b.length) { this.broadcast({ type: "sys", text: "no bridge connected", ts: Date.now() }, "user"); return; }
        for (const w of b) this.send(w, { type: "browser-click", x: m.x | 0, y: m.y | 0, callId: String(m.callId || "").slice(0, 40) });
        return;
      } else if (m.type === "typing" && canDrive) {
        const s = JSON.stringify({ type: "typing", from: who.name, on: !!m.on });
        for (const w of this.users()) if (w !== ws) { try { w.send(s); } catch {} }
      } else if (m.type === "marathon" && role === "owner") { // the Turn panel's Marathon switch; the bridge owns the mode and reports it back in "session"
        const b = this.bridges(); if (!b.length) { this.send(ws, { type: "sys", text: "No bridge connected — Marathon mode didn't change.", ts: Date.now() }); if (this.session) this.send(ws, { type: "session", ...this.session }); return; } // the echo puts the switch back
        for (const w of b) this.send(w, { type: "marathon", on: m.on === true, by: who.name });
      } else if (m.type === "stop" && canDrive) {
        for (const w of this.bridges()) this.send(w, { type: "stop", by: who.name });
      } else if (m.type === "clear" && role === "owner") {
        await this.clearLog();
        this.broadcast({ type: "cleared", by: who.name }, "user");
      } else if ((m.type === "login" || m.type === "login-code") && role === "owner") {
        // host-machine login, owner only: a driver must never be able to start an auth flow or push a code at it.
        // The code goes straight through to the bridge's waiting process — never stored, never broadcast, never logged.
        const b = this.bridges();
        if (!b.length) { this.send(ws, { type: "sys", text: "no bridge connected — the host machine is offline", ts: Date.now() }); return; }
        for (const w of b) this.send(w, m.type === "login" ? { type: "login", by: who.name } : { type: "login-code", code: String(m.code || "").slice(0, 400) });
        return;
      } else if (m.type === "approve" && role === "owner" && typeof m.id === "string") {
        await this.decide(m.id, m.ok ? "allowed" : "denied", who.name);
      } else if (m.type === "ping") { this.send(ws, { type: "pong" }); }
      return;
    }
    if (role === "bridge") {
      if (m.type === "hb") { if (this.status.running !== !!m.running) { this.status.running = !!m.running; this.status.current = m.current || null; await this.saveMeta(); this.broadcast({ type: "status", ...this.status }, "user"); } this.broadcast({ type: "hb", running: !!m.running, current: m.current || null, since: m.since || null, lastTool: m.lastTool || null, task: m.task || null, queue: m.queue | 0, t: Date.now() }, "user"); return; }
      if (m.type === "start") { this.partial = { id: m.id, text: "" }; this.outbox = this.outbox.filter(e => e.id !== m.id); this.status.running = true; this.status.queue = Math.max(0, this.status.queue - 1); this.status.current = m.id; await this.saveMeta(); this.broadcast({ type: "queue", items: this.queueList() }, "user"); this.broadcast({ type: "status", ...this.status }, "user"); }
      else if (m.type === "delta") { if (!this.partial || this.partial.id !== m.id) this.partial = { id: m.id, text: "" }; if (this.partial.text.length < 400000) this.partial.text += String(m.text || ""); this.broadcast(m, "user"); }
      else if (m.type === "tool" || m.type === "tool_result") { const e = { ...m, ts: Date.now() }; await this.push(e); this.broadcast(e, "user"); }
      else if (m.type === "done" || m.type === "error") { this.partial = null;
        const e = { ...m, ts: Date.now() }; await this.push(e);
        if (m.type === "done" && m.cost) this.costTotal += Number(m.cost) || 0;
        if (m.type === "done" && m.ctx && m.ctxMax) this.ctx = { now: +m.ctx || 0, max: +m.ctxMax || 0 };
        this.outbox = this.outbox.filter(x => x.id !== m.id);
        delete this.turnTok[m.id]; // its cost was charged by the "spend" message the bridge sends just before done/error
        this.status.running = false; this.status.current = null; await this.saveMeta();
        this.broadcast({ ...e, roomCost: this.costTotal }, "user"); this.broadcast({ type: "status", ...this.status }, "user"); // roomCost rides the live broadcast only — the stored entry stays per-turn, hello carries the durable total
        await this.bumpActivity(who.room, who.tenant || ""); // no bridge fan-out on this path, so nothing here to reorder — awaited so the subrequest isn't cancelled on return
      }
      else if (m.type === "spend") { // every attempt's cost (retries, stops, crashes, a driver's /compact) → the driver who sent that message
        const tt = this.turnTok[m.id]; if (m.final) { delete this.turnTok[m.id]; await this.saveMeta(); }
        const t = tt && tt.startsWith("c:") ? tt.slice(2) : tt;
        if (t && Number(m.cost) > 0) { const st = await this.budget("spend", { t, cost: m.cost, room: who.room, model: m.model }, who.tenant || ""); if (st && st.limited) this.sendToToken(t, { type: "budget", ...driverView(st) }); }
      }
      else if (m.type === "session") { this.session = { id: m.id, cwd: m.cwd, model: m.model || null, tier: m.tier || null, effort: m.effort || null, runLocal: !!m.runLocal, marathon: ["auto", "full", "off"].includes(m.marathon) ? m.marathon : null }; await this.saveMeta(); this.broadcast({ type: "session", ...this.session }, "user"); }
      else if (m.type === "uploaded" || m.type === "upload_error" || m.type === "route" || m.type === "compacted") { if (m.type === "compacted") { const max = +m.ctxMax || this.ctx?.max || 0; this.ctx = max ? { now: +m.ctx || 0, max } : null; await this.saveMeta(); } this.broadcast(m, "user"); }
      else if (m.type === "catalog") { const c = cleanCatalog(m); if (c && c.ts !== this.catalog?.ts) { this.catalog = c; await this.saveMeta(); this.broadcast({ type: "catalog", ...c }, "user"); } }
      else if (m.type === "colors") { this.colors = { ...this.colors, ...(m.colors || {}) }; await this.saveMeta(); this.broadcast({ type: "colors", colors: this.colors }, "user"); }
      else if (m.type === "sys" && m.owners) { const s = JSON.stringify({ type: "sys", text: String(m.text || "").slice(0, 300), ts: Date.now() }); this.toOwners(s); } // host-account details (plan quota): owners only, not stored in the shared log
      else if (m.type === "sys") { const e = { type: "sys", text: String(m.text || "").slice(0, 300), ts: Date.now() }; await this.push(e); this.broadcast(e, "user"); }
      else if (m.type === "commands") { this.commands = { list: Array.isArray(m.list) ? m.list.slice(0, 400).map(x => String(x).slice(0, 80)) : [], terminal: Array.isArray(m.terminal) ? m.terminal.slice(0, 200).map(x => String(x).slice(0, 80)) : [] }; this.broadcast({ type: "commands", ...this.commands }, "user"); } // in memory only: the bridge resends on every connect
      else if (m.type === "agents") { this.agents = Array.isArray(m.list) ? m.list.slice(0, 40) : []; await this.saveMeta(); this.broadcast({ type: "agents", list: this.agents }, "user"); }
      else if (m.type === "schedules") { this.schedules = Array.isArray(m.list) ? m.list : []; await this.saveMeta(); this.broadcast({ type: "schedules", list: this.schedules }, "user"); }
      else if (m.type === "auth") { // host login state: owners only, and stored so a reload still shows a logged-out host
        this.auth = { state: String(m.state || "").slice(0, 16), email: String(m.email || "").slice(0, 80), plan: String(m.plan || "").slice(0, 24), url: String(m.url || "").slice(0, 700), why: String(m.why || "").slice(0, 160), tail: String(m.tail || "").slice(0, 200), ts: m.ts || Date.now() };
        await this.saveMeta();
        const s = JSON.stringify({ type: "auth", ...this.auth });
        this.toOwners(s);
      }
      else if (m.type === "usage") { if (m.ts && m.ts === this.usage?.ts) return; this.usage = { limits: Array.isArray(m.limits) ? m.limits.slice(0, 12) : [], ts: m.ts || Date.now() }; await this.saveMeta(); const s = JSON.stringify({ type: "usage", ...this.usage }); this.toOwners(s); } // the host account's quota: owners only
      else if (m.type === "sync") { if (!m.running) this.partial = null; this.status = { running: !!m.running, queue: Math.max(0, m.queue | 0), current: m.current || null }; await this.saveMeta(); this.broadcast({ type: "status", ...this.status }, "user"); }
      else if (m.type === "ping") { this.send(ws, { type: "pong" }); }
    }
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code || 1000, reason || ""); } catch {} // complete the close handshake (see Hub)
    await this.load();
    const who = ws.deserializeAttachment() || {};
    if (who.role2 === "screen") { if (this.screen) { this.broadcast({ type: "screen", sid: this.screen.sid, end: true }, "user"); this.screen = null; } return; } // a run that died without saying so
    if (who.role2 === "bridge") { this.bridgeDownAt = Date.now(); this.status.running = false; this.status.current = null; await this.saveMeta(); this.broadcast({ type: "status", ...this.status }, "user"); }
    else this.broadcast({ type: "typing", from: who.name, on: false }, "user");
    this.presence(ws);
    await this.reportPresence(who.room, who.tenant || "");
  }
  async webSocketError(ws) { return this.webSocketClose(ws); }
}

/* ───────────────────────────── Registry ───────────────────────────── */
// Who the hosts are. One instance ("registry"), reached only from the router and from tenant Hubs — never forwarded
// from a public path. A host's key never reaches us: claim.mjs makes it on their machine and sends only sha256(secret).
export class Registry {
  constructor(state, env) { this.state = state; this.env = env; this.tenants = null; this.codes = null; }
  async load() { if (this.tenants === null) { this.tenants = (await this.state.storage.get("tenants")) || {}; this.codes = (await this.state.storage.get("codes")) || {}; } }
  async save() { await this.state.storage.put("tenants", this.tenants); await this.state.storage.put("codes", this.codes); }
  async fetch(req) {
    await this.load();
    const p = new URL(req.url).pathname; const b = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const T = this.tenants, C = this.codes, now = Date.now();
    if (p === "/check") { const t = Object.hasOwn(T, b.tenant) ? T[b.tenant] : null; return json({ ok: !!t && !t.disabled && (b.hash == null || safeEq(String(b.hash), t.hash)) }); }
    if (p === "/touch") { // counted in memory; written at most once a minute, so a chatty host can't turn this one DO into a write hotspot
      const t = Object.hasOwn(T, b.tenant) ? T[b.tenant] : null; if (t) { t.msgs = (t.msgs | 0) + 1; t.lastSeen = now; if (!(now - (this.flushed || 0) < 60000)) { this.flushed = now; await this.state.storage.put("tenants", T); } }
      return json({ ok: true });
    }
    if (p === "/claim") { // no await on anything but storage between the checks and the write, so two claims can't both consume one code
      const code = String(b.code || ""), c = Object.hasOwn(C, code) ? C[code] : null;
      if (!c || c.used || now - c.created > CODE_TTL) return bad("this host code is invalid, already used, or expired — ask for a new one", 409);
      const tn = String(b.tenant || "");
      if (!TENANT_RE.test(tn) || RESERVED_TENANTS.has(tn)) return bad("host name: 3–20 lowercase letters and digits (and not a reserved word)");
      if (Object.hasOwn(T, tn)) return bad("the host name " + tn + " is taken — pick another", 409);
      if (!/^[0-9a-f]{64}$/.test(String(b.hash || ""))) return bad("bad key hash");
      T[tn] = { hash: b.hash, created: now, note: c.note || "", msgs: 0, lastSeen: null, disabled: false };
      c.used = now; c.tenant = tn; await this.save();
      return json({ ok: true, tenant: tn });
    }
    if (p === "/code") { const code = token(24); C[code] = { created: now, note: String(b.note || "").trim().slice(0, 60), used: null }; await this.save(); return json({ ok: true, code, expires: now + CODE_TTL }); }
    if (p === "/code-del") { if (Object.hasOwn(C, b.code) && !C[b.code].used) { delete C[b.code]; await this.save(); } return json({ ok: true }); }
    if (p === "/delete") { if (!Object.hasOwn(T, b.tenant)) return bad("no such host", 404); if (!T[b.tenant].disabled) return bad("disable the host first", 409); delete T[b.tenant]; await this.save(); return json({ ok: true }); }
    if (p === "/disable") { if (!Object.hasOwn(T, b.tenant)) return bad("no such host", 404); T[b.tenant].disabled = !!b.disabled; await this.save(); return json({ ok: true }); }
    if (p === "/hosts") {
      for (const [k, c] of Object.entries(C)) if (!c.used && now - c.created > CODE_TTL + 30 * 86400e3) delete C[k]; // expired codes linger a month for the record, then go
      const hosts = Object.entries(T).map(([name, t]) => ({ name, created: t.created, note: t.note, msgs: t.msgs | 0, lastSeen: t.lastSeen, disabled: !!t.disabled }));
      const codes = Object.entries(C).filter(([, c]) => !c.used && now - c.created <= CODE_TTL).map(([code, c]) => ({ code, note: c.note, created: c.created, expires: c.created + CODE_TTL }));
      return json({ ok: true, hosts, codes });
    }
    return bad("not found", 404);
  }
}

/* ───────────────────────────── Router ───────────────────────────── */
const regPost = (env, path, body) => registry(env).fetch("https://reg" + path, { method: "POST", body: JSON.stringify(body) });
// key shapes: the root's JAM_KEY; a host's owner key "jamo_<tenant>_<secret>"; a host's invite "<tenant>.<token>"; a root invite "<token>"
async function auth(env, k, room) {
  // returns { tenant, role, name, room, token } or null
  if (!k) return null;
  if (safeEq(k, env.JAM_KEY)) return { tenant: "", role: "owner", name: null, room: roomName(room), token: "" };
  let m, tn = "";
  if ((m = /^jamo_([a-z0-9]{3,20})_([a-z0-9]{20,64})$/.exec(k))) {
    const ok = await (await regPost(env, "/check", { tenant: m[1], hash: await sha256hex(m[2]) })).json().catch(() => ({}));
    return ok.ok ? { tenant: m[1], role: "owner", name: null, room: roomName(room), token: "" } : null;
  }
  if ((m = /^([a-z0-9]{3,20})\.[a-z0-9]{6,40}$/.exec(k))) { // a host's invite: dead the moment the host is disabled
    tn = m[1]; const ok = await (await regPost(env, "/check", { tenant: tn })).json().catch(() => ({})); if (!ok.ok) return null;
  } else if (!/^[a-z0-9]{6,40}$/.test(k)) return null;
  const r = await hubFor(env, tn).fetch("https://hub/resolve?t=" + encodeURIComponent(k), { headers: tHdr(tn) });
  if (!r.ok) return null;
  const v = await r.json();
  return { tenant: tn, role: v.role, name: v.name, room: v.room, token: k };
}
const isRoot = a => !!a && a.tenant === "" && a.role === "owner" && !a.token; // the deployment owner: sponsor, hosts

export default {
  async fetch(req, env) {
    // x-jam-* headers are how the router tells a DO who's calling (tenant, role, room…) — never accept them from outside
    if ([...req.headers.keys()].some(k => k.startsWith("x-jam-") && k !== "x-jam-key")) { const h0 = new Headers(req.headers); for (const k of [...h0.keys()]) if (k.startsWith("x-jam-") && k !== "x-jam-key") h0.delete(k); req = new Request(req, { headers: h0 }); }
    const url = new URL(req.url); const p = url.pathname;
    const ui = () => new Response(Uint8Array.from(atob(B64), c => c.charCodeAt(0)), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    const keyOf = () => url.searchParams.get("k") || req.headers.get("x-jam-key") || "";

    if (p === "/ws") {
      const k = url.searchParams.get("k") || ""; const authed = Date.now();
      const a = await auth(env, k, url.searchParams.get("room"));
      if (!a) return new Response("nope", { status: 403 });
      const room = a.room; if (!room) return new Response("room required", { status: 400 });
      const isBridge = a.role === "owner" && !a.token && url.searchParams.get("role") === "bridge"; // the host's own key only — an owner-role invite must never become the bridge (sam-security 2026-10-15)
      const isScreen = a.role === "owner" && !a.token && url.searchParams.get("role") === "screen"; // browser.mjs live view: the host's owner key only
      const name = isBridge ? "bridge" : isScreen ? "browser" : (a.name || (url.searchParams.get("name") || "anon")).slice(0, 32);
      const h = new Headers(req.headers);
      h.set("x-jam-role", isBridge ? "bridge" : isScreen ? "screen" : a.role); h.set("x-jam-name", name); h.set("x-jam-token", a.token); h.set("x-jam-room", room); h.set("x-jam-tenant", a.tenant); h.set("x-jam-authed", String(authed));
      return roomFor(env, a.tenant, room).fetch(new Request("https://room/ws", { headers: h }));
    }
    if (p === "/hub") { // bridge + lobby sockets: a root or host owner key, never an invite
      const a = await auth(env, url.searchParams.get("k") || "", null);
      if (!a || a.role !== "owner" || a.token) return new Response("nope", { status: 403 });
      const h = new Headers(req.headers); h.set("x-jam-tenant", a.tenant);
      return hubFor(env, a.tenant).fetch(new Request(req, { headers: h }));
    }
    if (p === "/api/whoami") {
      const a = await auth(env, url.searchParams.get("k") || "", url.searchParams.get("room"));
      if (!a) return json({ ok: false }, 403);
      let room = null;
      if (a.room) { const r = await (await hubFor(env, a.tenant).fetch("https://hub/rooms", { headers: tHdr(a.tenant) })).json(); room = r.rooms.find(x => x.name === a.room) || { name: a.room }; }
      return json({ ok: true, role: a.role, name: a.name, room, host: a.tenant || null, root: isRoot(a), byInvite: !!a.token });
    }
    if (p === "/my-accessible-rooms") {
      const a = await auth(env, url.searchParams.get("k") || "", url.searchParams.get("room"));
      if (!a) return json({ ok: false }, 403);
      return hubFor(env, a.tenant).fetch("https://hub/my-accessible-rooms?role=" + encodeURIComponent(a.role) + "&room=" + encodeURIComponent(a.room || ""), { headers: tHdr(a.tenant) });
    }
    if (p === "/api/sponsor") { // GET is public (rendered in every room's UI, every host's too); POST (set) is the deployment owner's only
      if (req.method === "GET") return hubFor(env, "").fetch(new Request("https://hub/sponsor", { headers: tHdr("") }));
      if (req.method === "POST") {
        const a = await auth(env, keyOf(), null);
        if (!isRoot(a)) return json({ ok: false, error: "owner only" }, 403);
        return hubFor(env, "").fetch(new Request("https://hub/sponsor", { method: "POST", headers: tHdr(""), body: await req.text() }));
      }
      return bad("method not allowed", 405);
    }
    if (p === "/api/claim" && req.method === "POST") { // public: a one-time host code + a name + sha256 of a secret made on the claimer's machine
      const t = await req.text(); if (t.length > 2000) return bad("too large", 413);
      let b = {}; try { b = JSON.parse(t); } catch { return bad("json body required"); }
      return regPost(env, "/claim", { code: String(b.code || "").slice(0, 64), tenant: String(b.tenant || "").slice(0, 40), hash: String(b.hash || "").slice(0, 64) });
    }
    if (p === "/api/hosts" || p.startsWith("/api/hosts/")) { // the deployment owner's host admin
      const a = await auth(env, keyOf(), null);
      if (!isRoot(a)) return json({ ok: false, error: "owner only" }, 403);
      let m; const b = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      if (p === "/api/hosts" && req.method === "GET") return regPost(env, "/hosts", {});
      if (p === "/api/hosts/codes" && req.method === "POST") return regPost(env, "/code", { note: b.note });
      if ((m = /^\/api\/hosts\/codes\/([a-z0-9]+)$/.exec(p)) && req.method === "DELETE") return regPost(env, "/code-del", { code: m[1] });
      if ((m = /^\/api\/hosts\/([a-z0-9]{3,20})\/disable$/.exec(p)) && req.method === "POST") {
        const r = await regPost(env, "/disable", { tenant: m[1], disabled: b.disabled !== false }); if (!r.ok) return r;
        if (b.disabled !== false) { try { await hubFor(env, m[1]).fetch("https://hub/kick-all", { method: "POST", headers: tHdr(m[1]) }); } catch {} } // live sockets too, not just new ones
        return json({ ok: true, disabled: b.disabled !== false });
      }
      if ((m = /^\/api\/hosts\/([a-z0-9]{3,20})$/.exec(p)) && req.method === "DELETE") { // only a disabled host: wipe their rooms + hub, then forget them (name becomes claimable again)
        const st = await (await regPost(env, "/hosts", {})).json(); const x = (st.hosts || []).find(h => h.name === m[1]);
        if (!x) return bad("no such host", 404); if (!x.disabled) return bad("disable the host first", 409);
        const w = await hubFor(env, m[1]).fetch("https://hub/wipe-all", { method: "POST", headers: tHdr(m[1]) }); if (!w.ok) return bad("wipe failed", 500);
        return regPost(env, "/delete", { tenant: m[1] });
      }
      return bad("not found", 404);
    }
    if (p === "/dl/jam.tgz") return new Response(Uint8Array.from(atob(TGZ), c => c.charCodeAt(0)), { headers: { "content-type": "application/gzip", "content-disposition": 'attachment; filename="jam.tgz"', "cache-control": "no-store", "x-robots-tag": "noindex", "x-jam-bridge-build": TGZ_BUILD } });
    if (p === "/api/history" || p === "/api/export") {
      const a = await auth(env, url.searchParams.get("k") || "", url.searchParams.get("room"));
      if (!a || !a.room) return json({ ok: false }, 403);
      const h = new Headers(); h.set("x-jam-room", a.room); h.set("x-jam-tenant", a.tenant);
      return roomFor(env, a.tenant, a.room).fetch(new Request("https://room" + p.slice(4) + url.search, { headers: h }));
    }
    if (p.startsWith("/api/")) {
      const a = await auth(env, keyOf(), url.searchParams.get("room"));
      if (!a || a.role !== "owner") return json({ ok: false, error: "owner only" }, 403);
      const sub = p.slice(4); // /rooms..., /invites/...
      let m;
      if (/^\/rooms\/[^/]+\/(activity|presence)$/.test(sub) || /^\/budget\//.test(sub) || sub === "/kick-all" || sub === "/wipe-all") return bad("not found", 404); // internal-only: Room.bumpActivity / Room.reportPresence / the host-disable path call the Hub DO directly, never through this router
      if (a.token) { // owner-by-token: scoped to their room only
        const okRoom = (m = /^\/rooms\/([^/]+)/.exec(sub)) ? roomName(m[1]) === a.room : false;
        if (!okRoom && sub !== "/rooms" && !/^\/invites\/[^/]+\/budget$/.test(sub)) return json({ ok: false, error: "scoped to " + a.room }, 403); // budget paths: the Hub checks the invite's room via x-jam-scope
        if (sub === "/rooms" && req.method !== "GET") return json({ ok: false, error: "scoped to " + a.room }, 403);
      }
      if ((m = /^\/rooms\/([^/]+)\/drop$/.exec(sub)) && req.method === "POST") { // force every tab in a room to reconnect
        return roomFor(env, a.tenant, roomName(m[1])).fetch(new Request("https://room/drop", { method: "POST", headers: tHdr(a.tenant) }));
      }
      // /api/approve is bridge-side: forward to the room
      if ((m = /^\/approve(?:\/([^/]+))?$/.exec(sub))) {
        const room = roomName(url.searchParams.get("room")); if (!room) return bad("room required");
        return roomFor(env, a.tenant, room).fetch(new Request("https://room" + sub, req));
      }
      const fwd = new Request("https://hub" + sub, req); if (a.token) fwd.headers.set("x-jam-scope", a.room); else fwd.headers.delete("x-jam-scope");
      fwd.headers.set("x-jam-tenant", a.tenant);
      const res = await hubFor(env, a.tenant).fetch(fwd);
      if (a.token && sub === "/rooms") { const d = await res.json(); return json({ ...d, rooms: (d.rooms || []).filter(r => r.name === a.room) }); }
      return res;
    }
    if (p === "/" || p.startsWith("/r/") || p.startsWith("/j/")) return ui();
    if (p === "/health") return json({ ok: true, t: Date.now(), build: typeof BUILD === "string" ? BUILD : null, bridge: typeof TGZ_BUILD === "string" ? TGZ_BUILD : null });
    return Response.redirect(url.origin + "/", 302);
  }
};
