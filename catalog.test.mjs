// offline unit test for catalog.mjs — node catalog.test.mjs
import { parsePrices, shapeModels } from "./catalog.mjs";
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log("FAIL", msg); } };

const md = `| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
|---|---|---|---|---|---|
| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Sonnet 4 ([deprecated](https://x/y)) | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |
| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |

| Model | Batch Base Input | Batch Output | x | y | z |
| Claude Opus 5 | $2.50 / MTok | $12.50 / MTok | - | - | - |`;
const p = parsePrices(md);
ok(p["Claude Opus 5"]?.in === 5 && p["Claude Opus 5"]?.out === 25 && p["Claude Opus 5"]?.cacheRead === 0.5, "opus 5 base prices, first table wins");
ok(p["Claude Haiku 4.5"]?.in === 1 && p["Claude Haiku 4.5"]?.out === 5, "haiku prices");
ok(p["Claude Sonnet 4"]?.in === 3, "parenthetical/link suffix stripped from name");
ok(Object.keys(parsePrices("")).length === 0 && Object.keys(parsePrices(null)).length === 0, "empty page → no prices");

const eff = lv => ({ supported: lv.length > 0, ...Object.fromEntries(["low", "medium", "high", "xhigh", "max"].map(l => [l, { supported: lv.includes(l) }])) });
const data = [
  { id: "claude-opus-5", display_name: "Claude Opus 5", created_at: "2026-07-24T00:00:00Z", max_input_tokens: 1000000, max_tokens: 128000, capabilities: { effort: eff(["low", "medium", "high", "xhigh", "max"]) } },
  { id: "claude-opus-4-8", display_name: "Claude Opus 4.8", created_at: "2026-04-01T00:00:00Z", max_input_tokens: 1000000, max_tokens: 128000, capabilities: { effort: eff(["low", "medium", "high", "xhigh", "max"]) } },
  { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", created_at: "2025-10-01T00:00:00Z", max_input_tokens: 200000, max_tokens: 64000, capabilities: { effort: { supported: false } } },
  { id: "claude-fable-5-1", display_name: "Claude Fable 5.1", created_at: "2026-08-01T00:00:00Z", max_input_tokens: 1000000, capabilities: {} },
  { display_name: "no id" },
];
const m = shapeModels(data, p);
const by = id => m.find(x => x.id === id);
ok(m.length === 4, "entries without an id dropped");
ok(by("claude-opus-5").current && !by("claude-opus-4-8").current, "newest opus is current, older is not");
ok(by("claude-opus-5").label === "Opus 5" && by("claude-opus-5").family === "opus", "label strips 'Claude ', family parsed");
ok(by("claude-opus-5").window === 1000000 && by("claude-haiku-4-5-20251001").window === 200000, "windows from max_input_tokens");
ok(by("claude-opus-5").effort.length === 5 && by("claude-haiku-4-5-20251001").effort.length === 0, "effort levels from capabilities");
ok(by("claude-fable-5-1").effort === null, "missing capabilities → effort unknown (null), not none");
ok(shapeModels([{ id: "claude-lyric-6", display_name: "Claude Lyric 6", created_at: "2027-01-01T00:00:00Z" }])[0].current, "a new model family still shows up as current");
const shifted = `| Model | Region | Base Input Tokens | Cache Hits & Refreshes | Output Tokens |\n|---|---|---|---|---|\n| Claude Opus 5 | global | $5 / MTok | $0.50 / MTok | $25 / MTok |`;
ok(parsePrices(shifted)["Claude Opus 5"]?.in === 5 && parsePrices(shifted)["Claude Opus 5"]?.out === 25, "columns found by header, not position");
ok(by("claude-opus-5").price?.out === 25 && by("claude-opus-4-8").price === null, "prices matched by display name, missing → null");
ok(!("created" in by("claude-opus-5")), "internal created field not sent");
ok(shapeModels(null).length === 0, "null data → empty");
console.log(`catalog: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
