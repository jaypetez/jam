#!/usr/bin/env node
// Unit tests for turn-events.mjs: the stream-json reducer and its helpers. Plain Node, no framework (see CLAUDE.md).
import { trimInput, intentLine, toolSummary, estimateCost, newTurnState, reduceStreamEvent, TOOL_LABEL } from "./turn-events.mjs";
let pass = 0, fail = 0;
const t = (name, ok, extra = "") => { if (ok) pass++; else { fail++; console.log(`FAIL ${name} ${extra}`); } };
const eq = (name, a, b) => t(name, JSON.stringify(a) === JSON.stringify(b), `\n  got  ${JSON.stringify(a)}\n  want ${JSON.stringify(b)}`);

// trimInput
eq("trimInput Bash keeps command+description", trimInput("Bash", { command: "ls", description: "d", extra: 1 }), { command: "ls", description: "d" });
t("trimInput Bash cuts at 2000", trimInput("Bash", { command: "x".repeat(2500) }).command.length === 2001);
eq("trimInput Edit", trimInput("Edit", { file_path: "a", old_string: "o", new_string: "n", z: 1 }), { file_path: "a", old_string: "o", new_string: "n" });
t("trimInput Write cuts at 2000", trimInput("Write", { file_path: "a", content: "y".repeat(3000) }).content.length === 2001);
eq("trimInput other stringifies and cuts at 400", Object.values(trimInput("Grep", { pattern: "p", n: { a: 1 } })), ["p", '{"a":1}']);
t("trimInput tolerates undefined input", Object.keys(trimInput("Grep", undefined)).length === 0);

// intentLine
t("intentLine empty → null", intentLine("") === null && intentLine(null) === null && intentLine("ab\n  \n") === null);
t("intentLine takes the last real line, strips markdown and trailing punctuation", intentLine("first line here\n**Fixing the heartbeat task field:**") === "Fixing the heartbeat task field");
t("intentLine caps long lines at 237 chars + an ellipsis", intentLine("z".repeat(500)).length === 238 && intentLine("z".repeat(500)).endsWith("…"));

// toolSummary
t("toolSummary Agent shows @type — description", toolSummary("Agent", { subagent_type: "qa", description: "check" }) === "@qa — check");
t("toolSummary prefers command, then file_path", toolSummary("Bash", { command: "ls -la" }) === "ls -la" && toolSummary("Read", { file_path: "/a/b" }) === "/a/b");
t("toolSummary flattens newlines and caps at 200", toolSummary("Bash", { command: "a\n  b" }) === "a ⏎ b" && toolSummary("Bash", { command: "q".repeat(300) }).length === 200);
t("toolSummary falls back to JSON", toolSummary("X", { weird: 1 }) === '{"weird":1}');

// estimateCost: usage × catalog prices, 0 when the model or price is unknown
const models = [{ id: "claude-sonnet-5", price: { in: 3, out: 15, cacheRead: 0.3 } }];
const usages = new Map([["m1", { input_tokens: 1000000, output_tokens: 1000000, cache_read_input_tokens: 1000000, cache_creation_input_tokens: 1000000 }]]);
t("estimateCost sums in/out/cacheRead/cacheCreate (1.25× in)", estimateCost(models, "claude-sonnet-5", usages) === 3 + 15 + 0.3 + 3.75);
t("estimateCost prefix-matches model ids", estimateCost(models, "claude-sonnet-5-20260101", usages) > 0);
t("estimateCost is 0 for an unknown model, a missing catalog or no price", estimateCost(models, "other", usages) === 0 && estimateCost(undefined, "claude-sonnet-5", usages) === 0 && estimateCost([{ id: "claude-sonnet-5" }], "claude-sonnet-5", usages) === 0);
t("estimateCost defaults cacheRead to 10% of input price", estimateCost([{ id: "m", price: { in: 10, out: 0 } }], "m", new Map([["a", { cache_read_input_tokens: 1000000 }]])) === 1);

// reduceStreamEvent
const st = newTurnState();
const textDelta = s => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: s } } });
const textStart = { type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } };
eq("text delta is forwarded and accumulated", reduceStreamEvent(textDelta("Hello "), st, "i1"), [{ type: "delta", id: "i1", text: "Hello " }]);
t("text and sinceTool accumulate", st.text === "Hello " && st.sinceTool === "Hello ");
const sepOut = reduceStreamEvent(textStart, st, "i1");
t("a second text block gets a separator delta (blockSep)", sepOut.length === 1 && sepOut[0].type === "delta" && st.text.length > "Hello ".length, JSON.stringify(sepOut));
eq("a subagent's stream is ignored", reduceStreamEvent({ ...textDelta("SECRET"), parent_tool_use_id: "p" }, st, "i1"), []);
t("…and not accumulated", !st.text.includes("SECRET"));

const st2 = newTurnState();
reduceStreamEvent(textDelta("Fixing the heartbeat task field"), st2, "i2");
const toolOut = reduceStreamEvent({ type: "assistant", message: { id: "msg1", usage: { input_tokens: 5 }, content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "npm test" } }] } }, st2, "i2");
eq("tool_use → tool event with raw summary, sanitized label and intent task", toolOut, [{ type: "tool", id: "i2", callId: "c1", name: "Bash", summary: "npm test", label: "Running a command", input: { command: "npm test", description: undefined }, task: "Fixing the heartbeat task field" }]);
t("lastTool uses the sanitized label, never the raw command", st2.lastTool === TOOL_LABEL.Bash && st2.sinceTool === "");
t("usage is recorded per message id", st2.usages.get("msg1").input_tokens === 5);
reduceStreamEvent({ type: "assistant", message: { id: "msg1", usage: { input_tokens: 9 }, content: [] } }, st2, "i2");
t("a repeated message id overwrites (partial usage → final)", st2.usages.size === 1 && st2.usages.get("msg1").input_tokens === 9);

const st3 = newTurnState();
reduceStreamEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "TodoWrite", input: { todos: [{ status: "pending", activeForm: "No" }, { status: "in_progress", activeForm: "Building user colors" }] } }] } }, st3, "i3");
t("TodoWrite in_progress activeForm becomes the task", st3.currentTask === "Building user colors" && st3.lastTool === "Planning next steps");
reduceStreamEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "TodoWrite", input: { todos: [] } }] } }, st3, "i3");
t("TodoWrite with no in_progress item clears the task", st3.currentTask === null);
const unk = newTurnState(); reduceStreamEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "SomeNewTool", input: {} }] } }, unk, "i");
t("unknown tool gets the generic 'Working' label", unk.lastTool === "Working");

const st4 = newTurnState();
eq("tool_result with array content joins text blocks", reduceStreamEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", is_error: true, content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }] } }, st4, "i4"), [{ type: "tool_result", id: "i4", callId: "c1", is_error: true, text: "a\nb" }]);
const longRes = reduceStreamEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c2", content: "r".repeat(2000) }] } }, st4, "i4")[0];
t("tool_result text is capped at 1500 plus an ellipsis line", longRes.text.length === 1502 && longRes.text.endsWith("\n…") && longRes.is_error === false);
const final = { type: "result", result: "ok", total_cost_usd: 0.5 };
eq("result emits nothing mid-stream", reduceStreamEvent({ type: "result", result: "first" }, st4, "i4"), []);
reduceStreamEvent(final, st4, "i4");
t("only the LAST result is kept, and gotResult flips", st4.gotResult === true && st4.lastResult === final);
eq("unknown event types are ignored", reduceStreamEvent({ type: "system", subtype: "init" }, st4, "i4"), []);

console.log(`turn-events: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
