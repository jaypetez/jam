#!/usr/bin/env node
// Stand-in for the `claude` CLI for test-bridge-turn.mjs only. Behaviour is chosen by a SCEN:<name> marker in the prompt it is fed on
// stdin, so one stub covers a normal turn, a crash, a usage cap, an env probe and a compaction handoff. Every call is appended to
// <cwd>/.calls (model, mode, scenario) so the test can see what the bridge actually ran, in what order, on which model.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
const argv = process.argv.slice(2);
if (argv[0] === "auth" && argv[1] === "status") { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "stub@example.com", subscriptionType: "max" }) + "\n"); process.exit(0); }
if (!argv.includes("-p")) { process.stderr.write("stub: unsupported command\n"); process.exit(1); }
const flag = f => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : null; };
const model = flag("--model") || "unknown", json = flag("--output-format") === "json";
const mode = argv.includes("--resume") ? "resume" : argv.includes("--session-id") ? "new" : "?";
let stdin = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", d => stdin += d);
process.stdin.on("end", () => {
  const scen = (/SCEN:([\w-]+)/.exec(stdin) || [])[1] || (json ? "handoff" : "ok");
  const once = name => { const f = path.join(process.cwd(), "." + name); if (existsSync(f)) return false; writeFileSync(f, "1"); return true; };
  try { appendFileSync(path.join(process.cwd(), ".calls"), JSON.stringify({ model, mode, scen, json, handoff: /\[Handoff from the previous session/.test(stdin) }) + "\n"); } catch {}
  const out = o => process.stdout.write(JSON.stringify(o) + "\n");
  const usage = { input_tokens: 2000, output_tokens: 10 };
  if (json) { // compaction: `--output-format json`, either a resumed session or a transcript-fed one
    out({ type: "result", subtype: "success", is_error: false, result: "Handoff: the room is testing the bridge. ".repeat(12), total_cost_usd: 0.02, duration_ms: 3000, usage, modelUsage: {} });
    process.exit(0);
  }
  if (scen === "crash-once" && once("crashed")) process.exit(1); // dies with no result: the bridge must retry
  if (scen === "cap-once" && once("capped")) {
    out({ type: "result", subtype: "success", is_error: true, result: "You've reached your usage limit for this model.", total_cost_usd: 0, duration_ms: 3000, usage, modelUsage: {} });
    process.exit(0);
  }
  const text = scen === "env" ? `JAMKEY=${process.env.JAM_KEY ? "present" : "absent"} role=${process.env.JAM_FROM_ROLE} host=${process.env.JAM_HOST ? "set" : "unset"}`
    : scen === "handoff-check" ? `seed=${/\[Handoff from the previous session/.test(stdin) ? "yes" : "no"}`
    : `ok model=${model} mode=${mode}`;
  const half = Math.ceil(text.length / 2);
  out({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } });
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: text.slice(0, half) } } });
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: text.slice(half) } } });
  out({ type: "assistant", message: { id: "m1", usage, content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "ls -la" } }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "file1\nfile2" }] } });
  out({ type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0.01, duration_ms: 3000, usage, modelUsage: { [model]: { contextWindow: 200000, canonicalModel: model } } });
  process.exit(0);
});
