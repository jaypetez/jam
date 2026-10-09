// Chunked-upload assembly, extracted from bridge.mjs (2026-10-09 review). The browser sends base64 chunks over the room socket; this
// gathers them and writes ~/.jam/uploads/<room>/<ts>-<name>. Wire values are untrusted, so counts and sizes are bounded BEFORE
// anything is allocated (m.total used to go straight into new Array(), ahead of the 25MB check).
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export const MAX_BYTES = 25 * 1024 * 1024, MAX_CHUNKS = 4096, MAX_CHUNK_CHARS = 4 * 1024 * 1024, STALE_MS = 10 * 60 * 1000; // the UI sends 600k-char chunks; 25MB of base64 is ~34MB

export function createUploads({ stateDir, now = Date.now }) {
  const pending = new Map(); // id -> { name, chunks, total, got, t }
  const err = (id, text) => ({ reply: { type: "upload_error", id, text } });
  return {
    pending,
    // One chunk in. Returns null while more are expected, else { reply, logLine? } for the bridge to send (and log) — never throws.
    accept(roomName, m) {
      let u = pending.get(m.id);
      if (!u) {
        if (!Number.isInteger(m.total) || m.total < 1 || m.total > MAX_CHUNKS) return err(m.id, "bad upload");
        u = { name: m.name, chunks: new Array(m.total), total: m.total, got: 0, t: now() }; pending.set(m.id, u);
      }
      if (typeof m.data !== "string" || m.data.length > MAX_CHUNK_CHARS) { pending.delete(m.id); return err(m.id, "upload chunk too large"); }
      if (!Number.isInteger(m.seq) || m.seq < 0 || m.seq >= u.total || u.chunks[m.seq] != null) return null;
      u.chunks[m.seq] = m.data; u.got++;
      if (u.got < u.total) return null;
      pending.delete(m.id);
      try {
        const dir = path.join(stateDir, "uploads", roomName); mkdirSync(dir, { recursive: true });
        const safe = String(u.name).replace(/[^\w.-]+/g, "_").slice(0, 80) || "file";
        const file = path.join(dir, `${now()}-${safe}`);
        const buf = Buffer.from(u.chunks.join(""), "base64");
        if (buf.length > MAX_BYTES) throw new Error("file too large (25MB max)");
        writeFileSync(file, buf);
        return { reply: { type: "uploaded", id: m.id, name: u.name, path: file, size: buf.length }, logLine: ["upload", safe, buf.length + "B", "from", m.from] };
      } catch (e) { return err(m.id, e.message); }
    },
    // Drop half-finished uploads whose sender went away.
    sweep() { for (const [id, u] of pending) if (now() - u.t > STALE_MS) pending.delete(id); },
  };
}
