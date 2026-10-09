// Pure helpers for turning claude's stream-json output into room events. Extracted from bridge.mjs runOne (2026-10-09 review) so the
// reducer can be unit-tested without a `claude` binary. No imports from the bridge, no I/O: the bridge owns the child process and the socket.
import { blockSep } from "./turntext.mjs";

export function trimInput(name, inp) {
  const cut = (s, n) => typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : s;
  if (name === "Edit" || name === "MultiEdit") return { file_path: inp.file_path, old_string: cut(inp.old_string, 1500), new_string: cut(inp.new_string, 1500) };
  if (name === "Write") return { file_path: inp.file_path, content: cut(inp.content, 2000) };
  if (name === "Bash") return { command: cut(inp.command, 2000), description: inp.description };
  const o = {}; for (const [k, v] of Object.entries(inp || {})) o[k] = cut(typeof v === "string" ? v : JSON.stringify(v), 400); return o;
}

// Status-bar fallback when there's no in-progress TodoWrite to describe intent (see below): a generic,
// functional phrase per tool — never the raw command/path. Mike flagged raw tool calls leaking into the
// bar three times (2026-09-10); TodoWrite coverage alone isn't reliable enough, so this is the floor.
export const TOOL_LABEL = { Bash: "Running a command", Read: "Reading code", Write: "Writing a file", Edit: "Editing code",
  MultiEdit: "Editing code", NotebookEdit: "Editing a notebook", Grep: "Searching the code", Glob: "Looking for files",
  WebFetch: "Fetching a page", WebSearch: "Searching the web", Agent: "Consulting a teammate", TodoWrite: "Planning next steps" };

// Last non-empty line of the prose Claude wrote since its previous tool call, stripped of markdown, one line.
// Renders in two places with different widths (narrow sidebar .sline, full-width .topAct bar); both already
// have their own CSS overflow:hidden + text-overflow:ellipsis, so this only needs a sanity cap against
// pathological walls of text, not a tight one — a tight JS cap here truncates early in the wide bar even
// when there's plenty of room left (Mike caught this 2026-09-11: "…" mid-sentence with a blank bar after it).
export function intentLine(t) {
  const lines = String(t || "").split("\n").map(l => l.replace(/[`*_#>]+/g, "").replace(/\s+/g, " ").trim()).filter(l => l.length > 3);
  let l = lines[lines.length - 1] || ""; if (!l) return null;
  l = l.replace(/[.:…]+$/, ""); return l.length > 240 ? l.slice(0, 237) + "…" : l;
}

// The raw one-line description of a tool call for the expandable tool card only. The status bar must never render it (see TOOL_LABEL).
export function toolSummary(name, inp) {
  const s = name === "Agent" && inp.subagent_type ? "@" + inp.subagent_type + (inp.description ? " — " + inp.description : "") : (inp.command || inp.file_path || inp.pattern || inp.query || inp.description || inp.prompt || JSON.stringify(inp).slice(0, 160));
  return String(s).replace(/\s*\n\s*/g, " ⏎ ").slice(0, 200);
}

// cost of an attempt that ended without a result (Stop, crash): streamed per-message usage × catalog prices. `models` is the catalog's model list (or undefined before the first fetch).
export function estimateCost(models, model, usages) {
  const m = (models || []).find(x => model && (x.id === model || model.startsWith(x.id) || x.id.startsWith(model))), p = m?.price; if (!p) return 0;
  let c = 0; for (const u of usages.values()) c += ((u.input_tokens | 0) * p.in + (u.output_tokens | 0) * p.out + (u.cache_read_input_tokens | 0) * (p.cacheRead ?? p.in * 0.1) + (u.cache_creation_input_tokens | 0) * p.in * 1.25) / 1e6;
  return Math.round(c * 10000) / 10000;
}

// Per-turn parser state. The bridge copies lastTool/currentTask onto the room after each event (heartbeats read them there).
export const newTurnState = () => ({ text: "", sinceTool: "", usages: new Map(), gotResult: false, lastResult: null, lastTool: null, currentTask: null });

// One parsed stream-json event in, zero or more room messages out (the bridge does r.send on each); `st` is updated in place.
export function reduceStreamEvent(ev, st, id) {
  const out = [];
  if (ev.type === "stream_event") {
    const e = ev.event;
    if (ev.parent_tool_use_id) return out; // a subagent's own stream is not this turn's answer
    if (e?.type === "content_block_start" && e.content_block?.type === "text") { const sep = blockSep(st.text); if (sep) { st.text += sep; out.push({ type: "delta", id, text: sep }); } }
    if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") { st.text += e.delta.text; st.sinceTool += e.delta.text; out.push({ type: "delta", id, text: e.delta.text }); }
  } else if (ev.type === "assistant") {
    if (ev.message?.id && ev.message.usage) st.usages.set(ev.message.id, ev.message.usage);
    for (const c of ev.message?.content || []) if (c.type === "tool_use") {
      const inp = c.input || {};
      st.lastTool = TOOL_LABEL[c.name] || "Working"; // status-bar fallback stays functional; the raw command still goes out below, in the tool card
      // TodoWrite carries Claude's own stated intent (activeForm, e.g. "Building user colors") — prefer that
      // over the raw tool call for the one-line status, so it reads as "what" not "which file/command".
      if (c.name === "TodoWrite" && Array.isArray(inp.todos)) {
        const active = inp.todos.find(t => t.status === "in_progress");
        st.currentTask = active?.activeForm || null; // no in-progress todo → fall back to the last tool
      } else {
        // No TodoWrite in play (the usual case): Claude says in a line what it's about to do right before
        // the tool call. Use that line as the task so the bar reads "Fixing the heartbeat task field",
        // not "Running a command" (Mike: "i dont see what you're working on in the top status", 2026-09-10).
        const intent = intentLine(st.sinceTool); if (intent) st.currentTask = intent;
      }
      st.sinceTool = "";
      // `summary` (raw command/path) is for the expandable tool card only. The client's status bar must never render it directly
      // (the leak Mike flagged repeatedly on 2026-09-10): ship both, raw for the card, sanitized `label` for the status bar.
      out.push({ type: "tool", id, callId: c.id, name: c.name, summary: toolSummary(c.name, inp), label: TOOL_LABEL[c.name] || "Working", input: trimInput(c.name, inp), task: st.currentTask || null });
    }
  } else if (ev.type === "user") {
    for (const c of ev.message?.content || []) if (c.type === "tool_result") {
      const t = Array.isArray(c.content) ? c.content.filter(x => x.type === "text").map(x => x.text).join("\n") : String(c.content ?? "");
      out.push({ type: "tool_result", id, callId: c.tool_use_id, is_error: !!c.is_error, text: t.slice(0, 1500) + (t.length > 1500 ? "\n…" : "") });
    }
  } else if (ev.type === "result") {
    // A resumed session can emit more than one result per process (e.g. a task-notification for a background
    // subagent left over from the previous turn gets its own empty result 38ms in). Only the LAST one is the
    // real end of the turn, so stash it and send "done" once, when the process exits — never mid-turn.
    st.gotResult = true; st.lastResult = ev;
  }
  return out;
}
