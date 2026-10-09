#!/usr/bin/env node
// Unit tests for turn-text assembly (the "answer disappears after a tool call" bug). Offline; run by check.sh.
import { blockSep, closingText } from "./turntext.mjs";
let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };

ok(blockSep("") === "", "no separator before the first block");
ok(blockSep("Hello.") === "\n\n", "blank line between blocks");
ok(blockSep("Hello.\n") === "\n", "tops up a single trailing newline");
ok(blockSep("Hello.\n\n") === "", "no double separator");

// text → tool → text: simulate the stream
let s = "";
for (const block of ["Long answer with a table.", "I've added this to the notes."]) { s += blockSep(s) + block; }
ok(closingText(s, "I've added this to the notes.").includes("Long answer with a table."), "earlier block survives into done text");
ok(closingText(s, "I've added this to the notes.").endsWith("I've added this to the notes."), "closing block is still last");
ok(closingText("", "only the result") === "only the result", "falls back to result when nothing streamed");
ok(closingText("  \n", "") === "", "whitespace-only stream and empty result stay empty (caller shows the placeholder)");
process.exit(fail ? 1 : 0);
