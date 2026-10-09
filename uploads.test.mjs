#!/usr/bin/env node
// Unit tests for uploads.mjs: chunk assembly and the 2026-10-09 bounds. Plain Node, no framework (see CLAUDE.md).
import { createUploads, MAX_CHUNKS, MAX_CHUNK_CHARS, STALE_MS } from "./uploads.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
let pass = 0, fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } };

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-")); let t = 5000;
const U = createUploads({ stateDir, now: () => t });
const b64 = s => Buffer.from(s).toString("base64");

// a two-chunk upload, delivered out of order, with a duplicate chunk
{ const full = b64("hello world, this is a file"), a = full.slice(0, 8), b = full.slice(8);
  eq("first chunk (seq 1) is held", U.accept("r", { id: "u1", name: "my file!.txt", seq: 1, total: 2, data: b }), null);
  eq("a duplicate of a received chunk is ignored", U.accept("r", { id: "u1", name: "my file!.txt", seq: 1, total: 2, data: b }), null);
  const res = U.accept("r", { id: "u1", name: "my file!.txt", seq: 0, total: 2, data: a, from: "Ann" });
  eq("last chunk completes it", [res.reply.type, res.reply.id, res.reply.size, res.reply.name], ["uploaded", "u1", 27, "my file!.txt"]);
  eq("file lands under uploads/<room>/ with a sanitised name", [path.dirname(res.reply.path) === path.join(stateDir, "uploads", "r"), path.basename(res.reply.path)], [true, "5000-my_file_.txt"]);
  eq("bytes round-trip", fs.readFileSync(res.reply.path, "utf8"), "hello world, this is a file");
  eq("log line carries name, size, sender", res.logLine, ["upload", "my_file_.txt", "27B", "from", "Ann"]);
  eq("the finished upload is forgotten", U.pending.size, 0); }

// bounds (the 2026-10-09 review fix): nothing is allocated for a hostile total
for (const [name, total] of [["zero total", 0], ["negative total", -1], ["fractional total", 1.5], ["huge total", 2 ** 31], ["just over the chunk cap", MAX_CHUNKS + 1], ["string total", "3"], ["missing total", undefined]])
  eq(`rejects ${name} before allocating`, [U.accept("r", { id: "bad", name: "x", seq: 0, total, data: "AA" }).reply.text, U.pending.size], ["bad upload", 0]);
eq("the chunk cap itself is allowed", U.accept("r", { id: "max", name: "x", seq: 0, total: MAX_CHUNKS, data: "AA" }), null); U.pending.clear();
eq("an oversized chunk aborts the upload", [U.accept("r", { id: "big", name: "x", seq: 0, total: 2, data: "A".repeat(MAX_CHUNK_CHARS + 1) }).reply.text, U.pending.has("big")], ["upload chunk too large", false]);
eq("a non-string chunk is refused", U.accept("r", { id: "ns", name: "x", seq: 0, total: 1, data: 5 }).reply.type, "upload_error");
eq("out-of-range or non-integer seq is ignored", [U.accept("r", { id: "s", name: "x", seq: 5, total: 2, data: "AA" }), U.accept("r", { id: "s", name: "x", seq: -1, total: 2, data: "AA" }), U.accept("r", { id: "s", name: "x", seq: 0.5, total: 2, data: "AA" })], [null, null, null]);
U.pending.clear();

// size cap after assembly: 26MB of zeros in base64 (ceil → needs several chunks under the per-chunk cap)
{ const big = Buffer.alloc(26 * 1024 * 1024).toString("base64"), n = Math.ceil(big.length / 3_000_000); let last;
  for (let i = 0; i < n; i++) last = U.accept("r", { id: "huge", name: "z.bin", seq: i, total: n, data: big.slice(i * 3_000_000, (i + 1) * 3_000_000) });
  eq("a >25MB file is rejected after assembly with a clear message", [last.reply.type, last.reply.text], ["upload_error", "file too large (25MB max)"]);
  eq("…and nothing is left in memory", U.pending.size, 0); }

// an unnamed upload still gets a name
{ const r = U.accept("r", { id: "nn", name: undefined, seq: 0, total: 1, data: b64("x") }); eq("missing name → 'undefined' is sanitised, not a crash", r.reply.type, "uploaded"); }
{ const r = U.accept("r", { id: "nm", name: "///", seq: 0, total: 1, data: b64("x") }); eq("a name that sanitises to '_' stays a file name", path.basename(r.reply.path), "5000-_"); }

// stale sweep
U.accept("r", { id: "stale", name: "x", seq: 0, total: 2, data: "AA" });
t += STALE_MS; U.sweep(); eq("not yet stale at exactly the limit", U.pending.has("stale"), true);
t += 1; U.sweep(); eq("swept once older than ten minutes", U.pending.has("stale"), false);

fs.rmSync(stateDir, { recursive: true, force: true });
console.log(`uploads: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
