#!/usr/bin/env node
// jam's fake `claude` CLI: a deterministic stand-in for `claude -p` so the whole stack (and the live end-to-end suite) can run with no quota, no login
// and no network. Used by `npm run dev`, `npm run e2e`, test-stack.mjs and test-bridge-turn.mjs. The bridge runs it exactly like the real thing
// (JAM_CLAUDE=<this file>, same args, prompt on stdin, stream-json on stdout). WHAT it says lives in fake-claude-rules.mjs (pure, unit-tested); this
// file is the dumb part: protocol, files, the approval hook, and a tiny simulated shell.
//
// What makes it a faithful stand-in rather than a canned reply:
//   - it writes Claude Code's own session transcript (~/.claude/projects/<cwd>/<id>.jsonl), which the bridge reads to decide --resume vs --session-id and
//     to write a compaction handoff when no model can reload a session; `--resume` of a session with no transcript fails like the real CLI does;
//   - every tool call goes through the REAL approve-hook.mjs, so approval cards and blocks come from the real code path;
//   - it keeps a realistic context size (a real session already holds ~15k tokens on turn one), so the bridge's window and compaction logic fires.
// What it never does: run arbitrary commands. Bash calls hit a small simulated shell (echo, sleep, ls, pwd), so it is safe to type into.
//
// SCEN:<name> in a prompt picks a fixed legacy behaviour (test-bridge-turn.mjs): ok, env, handoff-check, crash-once, cap-once. Every call is appended to
// <cwd>/.calls (model, mode, scenario) so a test can see what the bridge actually ran, in what order, on which model.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import zlib from "node:zlib";
import { spawn } from "node:child_process"; import { fileURLToPath } from "node:url";
import { BASE_CTX, parseInput, extractFacts, mergeFacts, handoffText, pngPixel, plan } from "./fake-claude-rules.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
if (argv[0] === "auth" && argv[1] === "status") { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "fake@example.com", subscriptionType: "max" }) + "\n"); process.exit(0); }
if (!argv.includes("-p")) { process.stderr.write("fake claude: unsupported command\n"); process.exit(1); }
const flag = f => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : null; };
const model = flag("--model") || "unknown", json = flag("--output-format") === "json";
const mode = argv.includes("--resume") ? "resume" : argv.includes("--session-id") ? "new" : "?";
const sessionId = flag("--resume") || flag("--session-id") || "no-session";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = o => process.stdout.write(JSON.stringify(o) + "\n");

// ── session transcript (same path rule as session-store.mjs transcriptOf)
const transcriptFile = path.join(os.homedir(), ".claude", "projects", path.resolve(process.cwd()).replace(/[^a-zA-Z0-9]/g, "-"), sessionId + ".jsonl");
const readTranscript = () => { try { return fs.readFileSync(transcriptFile, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return null; } };
const appendTranscript = entries => { try { fs.mkdirSync(path.dirname(transcriptFile), { recursive: true }); fs.appendFileSync(transcriptFile, entries.map(e => JSON.stringify(e)).join("\n") + "\n"); } catch {} };
const userText = tr => (tr || []).filter(e => e.type === "user" && typeof e.message?.content === "string").map(e => e.message.content).join("\n");

// ── the simulated shell: a few harmless builtins, so a typed command can't do anything to the host
async function simShell(command, cwd) {
  const outTxt = []; let isError = false;
  for (const part of String(command).split(/\s*&&\s*/)) {
    const c = part.trim(); let m;
    if ((m = /^echo\s+(.*)$/s.exec(c))) outTxt.push(m[1].replace(/^(["'])(.*)\1$/s, "$2"));
    else if ((m = /^sleep\s+(\d+(?:\.\d+)?)$/.exec(c))) await sleep(Math.min(30, +m[1]) * 1000);
    else if ((m = /^ls(?:\s+-\w+)*(?:\s+(\S+))?$/.exec(c))) { const d = path.resolve(cwd, m[1] || "."); try { outTxt.push(fs.readdirSync(d).join("\n")); } catch { outTxt.push(`ls: cannot access '${m[1] || d}': No such file or directory`); isError = true; } }
    else if (c === "pwd") outTxt.push(cwd);
    else if (/^node\s+browser\.mjs\b/.test(c)) outTxt.push("(fake claude: the browser tool is not run here)");
    else if (/^git\s/.test(c)) { outTxt.push("fatal: not a git repository (fake claude does not run git)"); isError = true; }
    else { outTxt.push(`(fake claude: '${c.split(/\s/)[0]}' is not simulated)`); isError = true; }
    if (isError) break;
  }
  return { text: outTxt.join("\n"), isError };
}

// ── the real approval hook, called the way Claude Code calls a PreToolUse hook (JSON on stdin; exit 0 = allow, 2 = block)
function runHook(toolName, input) {
  return new Promise(res => {
    const env = { ...process.env }; if (env.JAM_FAKE_HUB_KEY) env.JAM_KEY = env.JAM_FAKE_HUB_KEY; // the real hook may read the key from disk; the dev stack's key is passed explicitly
    const h = spawn(process.execPath, [path.join(HERE, "..", "approve-hook.mjs")], { env, stdio: ["pipe", "ignore", "pipe"] });
    let err = ""; h.stderr.on("data", d => err += d);
    h.on("error", e => res({ code: 2, err: "hook failed to start: " + e.message }));
    h.on("close", code => res({ code, err }));
    h.stdin.end(JSON.stringify({ tool_name: toolName, tool_input: input }));
  });
}

let stdin = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", d => stdin += d);
process.stdin.on("end", async () => {
  const inp = parseInput(stdin);
  const once = name => { const f = path.join(process.cwd(), "." + name); if (fs.existsSync(f)) return false; fs.writeFileSync(f, "1"); return true; };
  const scen = inp.scen || (json ? "handoff" : null);
  try { fs.appendFileSync(path.join(process.cwd(), ".calls"), JSON.stringify({ model, mode, scen: scen || "ok", json, handoff: !!inp.seed }) + "\n"); } catch {}
  const prior = readTranscript();
  if (mode === "resume" && !json && prior === null) { process.stderr.write(`No conversation found with session ID: ${sessionId}\n`); process.exit(1); } // what the real CLI does
  const fixedCtx = !!inp.scen; // legacy scenario runs report a flat, small context so test-bridge-turn's arithmetic stays simple
  const ctxNow = (extra = 0) => (fixedCtx || json ? 2000 : BASE_CTX + Math.ceil((userText(prior).length + extra) / 4));
  const usage = c => ({ input_tokens: c, output_tokens: 10 });

  if (json) { // compaction: `--output-format json`, either a resumed session (write the handoff from memory) or a transcript-fed fresh one
    const facts = extractFacts(mode === "resume" ? userText(prior) : stdin);
    out({ type: "result", subtype: "success", is_error: false, result: handoffText(facts), total_cost_usd: 0.02, duration_ms: 3000, usage: usage(2000), modelUsage: {} });
    process.exit(0);
  }
  if (inp.scen === "crash-once" && once("crashed")) process.exit(1); // dies with no result: the bridge must retry
  if (inp.scen === "cap-once" && once("capped")) {
    out({ type: "result", subtype: "success", is_error: true, result: "You've reached your usage limit for this model.", total_cost_usd: 0, duration_ms: 3000, usage: usage(2000), modelUsage: {} });
    process.exit(0);
  }

  // facts the session knows: what was said earlier in it, the handoff the bridge seeded it with, and this message
  const facts = mergeFacts(extractFacts(userText(prior)), extractFacts(inp.seed), extractFacts(inp.text));
  const readImage = p => { try { return pngPixel(fs.readFileSync(p), zlib.inflateSync); } catch { return null; } };
  const script = plan({ text: inp.text, from: inp.from, facts, attachments: inp.attachments, readImage, scen: inp.scen, model, mode, seed: inp.seed, env: process.env });

  let msgN = 0, toolN = 0, said = "", outTokens = 10; const tlog = [{ type: "user", message: { role: "user", content: stdin.trim() } }];
  const emitText = async (text, chunk = 0, gapMs = 0) => {
    out({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } });
    const parts = chunk > 0 ? text.match(new RegExp(`[\\s\\S]{1,${chunk}}`, "g")) || [""] : (() => { const h = Math.ceil(text.length / 2); return [text.slice(0, h), text.slice(h)]; })();
    for (const p of parts) { if (!p) continue; out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: p } } }); if (gapMs) await sleep(gapMs); }
    said += text; outTokens += Math.ceil(text.length / 4); tlog.push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  };
  const exec = async steps => {
    for (const s of steps || []) {
      if (s.type === "say") await emitText(s.text, s.chunk, s.gapMs);
      else if (s.type === "sleep") await sleep(s.ms);
      else if (s.type === "tool") {
        const id = "toolu_fake_" + (++toolN);
        out({ type: "assistant", message: { id: "msg_fake_" + (++msgN), usage: usage(ctxNow(said.length)), content: [{ type: "tool_use", id, name: s.name, input: s.input }] } });
        tlog.push({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: s.name, input: s.input }] } });
        let res, blocked = false;
        if (s.canned !== undefined) res = { text: s.canned, isError: false };
        else { const h = await runHook(s.name, s.input); if (h.code === 0) res = s.name === "Bash" ? await simShell(s.input.command, process.cwd()) : { text: "(fake claude: tool not simulated)", isError: false }; else { blocked = true; res = { text: (h.err || "blocked by the approval hook").trim().slice(-600), isError: true }; } }
        out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: res.isError, content: res.text }] } });
        tlog.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: res.text }] } });
        await exec(blocked ? s.blocked : s.ok);
      }
    }
  };
  await exec(script);
  const ctx = ctxNow(said.length);
  appendTranscript(tlog);
  out({ type: "result", subtype: "success", is_error: false, result: said, total_cost_usd: 0.01, duration_ms: 3000, num_turns: 1, session_id: sessionId, usage: { input_tokens: ctx, output_tokens: outTokens },
    modelUsage: { [model]: { contextWindow: 200000, canonicalModel: model, inputTokens: ctx, outputTokens: outTokens } } });
  process.exit(0);
});
