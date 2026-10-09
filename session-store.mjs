// Host-side persistence for rooms, extracted from bridge.mjs (2026-10-09 review): session ids, per-room queues, user colors and the
// seed/notes file locations. Everything is rooted at an injected `stateDir` (the bridge passes ~/.jam) and `home` (for Claude Code's own
// ~/.claude/projects transcripts), so tests run against a temp dir and never touch the real host state.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const PALETTE = ["#b78cf7", "#7dcfff", "#ff9e64", "#f27a8a", "#f0b860", "#5fd3a1", "#e0c3fc"];

export function createStore({ stateDir, home, log = () => {} }) {
  mkdirSync(path.join(stateDir, "sessions"), { recursive: true });
  const S = { stateDir };

  /* ── user colors: persistent unique colors per user, Claude always fixed ── */
  const userColorsFile = path.join(stateDir, "user-colors.json");
  let userColors = {};
  const saveUserColors = () => { try { writeFileSync(userColorsFile, JSON.stringify(userColors)); } catch {} };
  S.loadUserColors = () => { try { userColors = JSON.parse(readFileSync(userColorsFile, "utf8")); } catch {} return userColors; };
  Object.defineProperty(S, "userColors", { get: () => userColors });
  S.assignColor = name => {
    if (name === "Claude") return "#86d68a"; // fixed green for Claude
    if (userColors[name]) return userColors[name];
    const used = Object.values(userColors); const available = PALETTE.filter(c => !used.includes(c));
    userColors[name] = available.length ? available[0] : PALETTE[Object.keys(userColors).length % PALETTE.length];
    saveUserColors(); return userColors[name];
  };
  S.loadUserColors();

  /* ── queue persistence: save/load per-room queue across bridge restarts ── */
  S.queueFile = roomName => path.join(stateDir, "queue-" + roomName + ".json");
  S.saveQueue = r => { try { writeFileSync(S.queueFile(r.cfg.name), JSON.stringify(r.queue)); } catch {} };
  S.loadQueue = roomName => { try { return JSON.parse(readFileSync(S.queueFile(roomName), "utf8")); } catch { return []; } };

  /* ── room files next to the session ── */
  S.sessionFile = name => path.join(stateDir, "sessions", name + ".json");
  S.seedFile = r => path.join(stateDir, "sessions", r.cfg.name + ".seed.md");
  S.notesFile = r => path.join(stateDir, "sessions", r.cfg.name + ".notes.md");

  // ~/.jam/sessions/<room>.json = { id, cwd, byCwd: { <cwd>: <session id> } } — a room that moves back to a directory it
  // ran in before picks that conversation up again instead of starting cold.
  S.readSess = f => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
  S.writeSess = (f, id, cwd, prev, ctx) => {
    const byCwd = { ...(prev?.byCwd || {}) }; if (prev?.id && prev.cwd) byCwd[prev.cwd] = prev.id; byCwd[cwd] = id;
    writeFileSync(f, JSON.stringify({ id, cwd, byCwd, ctx: ctx ?? (prev?.id === id ? prev.ctx : 0) ?? 0 }));
  };
  // Claude Code keeps transcripts at ~/.claude/projects/<cwd with every non-alphanumeric → "-">/<id>.jsonl. A session id
  // with no transcript can't be resumed ("No conversation found"), so it's fresh: --session-id creates it. That happens
  // when compaction picks a new id and the bridge restarts before the first turn writes it (2026-09-14: every #jam turn failed).
  S.transcriptOf = (cwd, id) => path.join(home, ".claude", "projects", String(path.resolve(cwd)).replace(/[^a-zA-Z0-9]/g, "-"), id + ".jsonl");
  S.resumable = (cwd, id) => existsSync(S.transcriptOf(cwd, id));
  S.sessionFor = cfg => {
    const f = S.sessionFile(cfg.name);
    const j = existsSync(f) ? S.readSess(f) : null;
    const known = (id, extra) => { const fresh = !S.resumable(cfg.cwd, id); if (fresh) log(`#${cfg.name}`, "session", id.slice(0, 8), "has no transcript yet — starting it fresh"); return { id, fresh, ...extra }; };
    if (j?.id && j.cwd === cfg.cwd) return known(j.id, { ctx: j.ctx | 0 });
    const prev = j?.byCwd?.[cfg.cwd];
    if (prev) { S.writeSess(f, prev, cfg.cwd, j); log(`#${cfg.name}`, "back in", cfg.cwd, "— resuming its earlier session"); return known(prev); }
    const legacy = path.join(cfg.cwd, ".jam-session"); // pre-multi-room bridges kept it in the cwd
    if (existsSync(legacy)) { const id = readFileSync(legacy, "utf8").trim(); if (id) { S.writeSess(f, id, cfg.cwd, j); return known(id); } }
    const id = randomUUID(); S.writeSess(f, id, cfg.cwd, j); return { id, fresh: true };
  };
  S.saveSession = r => { const f = S.sessionFile(r.cfg.name); S.writeSess(f, r.sessionId, r.cfg.cwd, existsSync(f) ? S.readSess(f) : null, r.lastCtx | 0); };
  return S;
}
