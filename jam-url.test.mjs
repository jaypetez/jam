#!/usr/bin/env node
// Unit tests for jam-url.mjs. Plain Node, no framework (see CLAUDE.md).
import { isLoopback, isSecure, httpBase, wsBase, DEFAULT_HOST } from "./jam-url.mjs";
let pass = 0, fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } };
const none = {};

eq("default host is the production hub", DEFAULT_HOST, "jam.nullagency.io");
eq("production hostnames stay TLS with no env (behaviour must not change)", [httpBase("jam.nullagency.io", none), wsBase("jam.nullagency.io", none)], ["https://jam.nullagency.io", "wss://jam.nullagency.io"]);
eq("workers.dev hosts stay TLS", wsBase("jam.me.workers.dev", none), "wss://jam.me.workers.dev");
for (const h of ["127.0.0.1", "127.0.0.1:8787", "127.1.2.3:80", "localhost", "localhost:8787", "LOCALHOST:1", "::1", "[::1]", "[::1]:8787"])
  eq(`loopback ${h} defaults to plain http/ws`, [isLoopback(h), httpBase(h, none), wsBase(h, none)], [true, "http://" + h, "ws://" + h]);
for (const h of ["128.0.0.1", "127.0.0.1.evil.com", "evil127.0.0.1", "localhost.evil.com", "example.com:8787", "10.0.0.5:8787", "", undefined])
  eq(`non-loopback ${JSON.stringify(h)} is not treated as local (a lookalike must never downgrade to http)`, isLoopback(h), false);
eq("JAM_SCHEME=http forces http for any host", [httpBase("jam.example.com", { JAM_SCHEME: "http" }), wsBase("jam.example.com", { JAM_SCHEME: "HTTP" })], ["http://jam.example.com", "ws://jam.example.com"]);
eq("JAM_SCHEME=https forces TLS even for loopback", [httpBase("127.0.0.1:8787", { JAM_SCHEME: "https" }), wsBase("localhost", { JAM_SCHEME: "https" })], ["https://127.0.0.1:8787", "wss://localhost"]);
eq("an unknown JAM_SCHEME is ignored, not trusted", [isSecure("jam.example.com", { JAM_SCHEME: "ftp" }), isSecure("127.0.0.1", { JAM_SCHEME: "ftp" })], [true, false]);
eq("an empty JAM_SCHEME is ignored", isSecure("jam.example.com", { JAM_SCHEME: "" }), true);
eq("reads process.env by default", (() => { const was = process.env.JAM_SCHEME; process.env.JAM_SCHEME = "http"; const r = httpBase("x.example"); if (was === undefined) delete process.env.JAM_SCHEME; else process.env.JAM_SCHEME = was; return r; })(), "http://x.example");

console.log(`jam-url: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
