// The brain of jam's fake claude (dev/fake-claude.mjs): pure functions that turn what the bridge feeds `claude -p` on stdin into a SCRIPT of steps.
// Nothing here touches the filesystem, a clock or a process, so every rule is unit-tested (fake-claude.test.mjs) and the CLI wrapper stays dumb.
//
// Why a rules table and not a mock model: the live end-to-end tests (test.mjs, compact.test.mjs, switch.test.mjs, ...) were written against a real
// Claude and assert on what it said. Each rule below is the minimum a real Claude would have done for that prompt, so the suite can run with no
// quota, no login and no network. It is a MODEL of the CLI, not the CLI: `npm run e2e:real` keeps the real thing as an opt-in smoke.
//
// A script is an array of steps:
//   { type: "say",  text, chunk?, gapMs? }                    stream text (chunk = chars per delta, gapMs = pause between deltas)
//   { type: "sleep", ms }                                     take time (so a turn is observably "working")
//   { type: "tool", name, input, ok?: [steps], blocked?: [steps], canned? }   call a tool through the REAL approval hook, then continue with `ok` or `blocked`
//                                                             (canned = a fixed result: skips the hook and the simulated shell)
//
// Input layout the bridge produces (bridge.mjs runOne): [room notes block] [handoff seed block] "[<from>]: <text>" [attachments footer].

export const BASE_CTX = 15500; // tokens a real Claude Code session already holds on its first turn (system prompt + tool definitions)

// ── input
export function parseInput(stdin) {
  let s = String(stdin || "");
  const notes = /^\[Room notes[\s\S]*?\n\n---\n\n/.exec(s); if (notes) s = s.slice(notes[0].length);
  let seed = null; const sm = /^\[Handoff from the previous session[^\]]*\]\n\n([\s\S]*?)\n\n---\n\n/.exec(s); if (sm) { seed = sm[1]; s = s.slice(sm[0].length); }
  const fm = /^\[([^\]\n]{1,40})\]: /.exec(s); const from = fm ? fm[1] : null; if (fm) s = s.slice(fm[0].length);
  const att = /\n\n\[Attachments from [^,\]]*, saved on this machine: ([^\]]+)\]/.exec(s);
  const attachments = att ? att[1].split(/,\s+(?=\/|[A-Za-z]:[\\/])/).map(x => x.trim()) : [];
  const text = (att ? s.slice(0, att.index) : s).trim();
  const scen = (/SCEN:([\w-]+)/.exec(String(stdin || "")) || [])[1] || null;
  return { from, text, seed, attachments, scen };
}

// ── memory: the facts the live tests plant ("my favorite color is teal and the project codename is Bluebird", "the codeword is Marigold")
// "is" for what people type, ":" for what describeFacts() writes into a handoff: a compaction round trip (fact -> handoff -> fresh session) must not lose it.
const FACT_RES = [["color", /favou?rite colou?r(?: is|:)\s*([A-Za-z]+)/i], ["codename", /codename(?: is|:)\s*([A-Za-z]+)/i], ["codeword", /code ?word(?: is|:)\s*([A-Za-z]+)/i]];
export function extractFacts(text) {
  const f = {}; for (const [k, re] of FACT_RES) { const m = re.exec(String(text || "")); if (m) f[k] = m[1]; } return f;
}
export const mergeFacts = (...sets) => Object.assign({}, ...sets.filter(Boolean));
export const describeFacts = f => Object.entries(f).map(([k, v]) => ({ color: "favorite color", codename: "project codename", codeword: "codeword" }[k] + ": " + v)).join("; ");

// A compaction handoff, as Claude would write it from memory (resume mode) or from a transcript (transcript mode). The bridge rejects anything under 200 chars.
export function handoffText(facts) {
  const lines = ["# Handoff", "", "This room is exercising jam's end-to-end loop with a fake claude; the people in it are testing, not shipping."];
  const d = describeFacts(facts); lines.push("", d ? "Facts to carry over: " + d + "." : "No durable facts were recorded in this session.");
  lines.push("", "Open items: none. Next step: carry on from the last exchange. Rules: no secrets, no keys.");
  let t = lines.join("\n"); while (t.length < 220) t += "\nHandoff: the room is testing the bridge."; return t;
}

// ── PNG: enough of a decoder to name the colour of the first pixel (8-bit grey / RGB / palette / RGBA, any filter: a lone first pixel has no neighbours)
export function pngPixel(buf, inflate) {
  if (!buf || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let off = 8, ihdr = null, plte = null; const idat = [];
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString("latin1", off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], ctype: data[9] };
    else if (type === "PLTE") plte = data; else if (type === "IDAT") idat.push(data); else if (type === "IEND") break;
    off += 12 + len;
  }
  if (!ihdr || ihdr.depth !== 8 || !idat.length) return null;
  let raw; try { raw = inflate(Buffer.concat(idat)); } catch { return null; }
  const px = raw.subarray(1); // first scanline, after its filter byte
  if (ihdr.ctype === 2 || ihdr.ctype === 6) return px.length >= 3 ? [px[0], px[1], px[2]] : null;
  if (ihdr.ctype === 0 || ihdr.ctype === 4) return px.length >= 1 ? [px[0], px[0], px[0]] : null;
  if (ihdr.ctype === 3 && plte && px.length >= 1) return [plte[px[0] * 3], plte[px[0] * 3 + 1], plte[px[0] * 3 + 2]];
  return null;
}
export function colourName([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (max < 50) return "black"; if (min > 205 && d < 30) return "white"; if (d < 25) return "gray";
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h = (h * 60 + 360) % 360;
  if (h < 15 || h >= 345) return "red"; if (h < 40) return "orange"; if (h < 70) return "yellow"; if (h < 170) return "green"; if (h < 200) return "cyan"; if (h < 260) return "blue"; if (h < 315) return "purple"; return "pink";
}

// ── the rules. `ctx` = { text, from, role, facts, attachments, readImage(path) -> [r,g,b]|null }. First match wins; every rule returns a script.
const say = (text, o = {}) => ({ type: "say", text, ...o });
const sleep = ms => ({ type: "sleep", ms });
const tool = (input, ok, blocked, name = "Bash") => ({ type: "tool", name, input, ok, blocked });
export const RULES = [
  // 1. the exact-word reply the protocol test uses as its liveness check
  { name: "exact word", re: /reply with exactly the single word (\w+)/i, run: (m) => [say(m[1])] },
  // 2. a command the test wants run through the approval gate; what happens next depends on the owner's decision
  { name: "run exact command", re: /run this exact bash command[^:]*:\s*(.+)$/is, run: (m) => [say("Running it now."), tool({ command: m[1].trim() }, [say("It ran. Here is what it printed.")], [say("That command was blocked, so I did not run it.")])] },
  { name: "bash then reply", re: /use the bash tool to run:\s*(.+?)\.?\s*then reply (\w+)/is, run: (m) => [say("Running that."), tool({ command: m[1].trim() }, [say(m[2])], [say("Blocked.")])] },
  { name: "bash, reply with word", re: /use bash to run:\s*(.+?)\.\s*reply with the word (\w+)/is, run: (m) => [tool({ command: m[1].trim() }, [say(m[2])], [say("Blocked.")])] },
  // 3. status-bar tests: a multi-tool turn, then the exact repro command from the regression
  { name: "multi-tool turn", re: /run 'echo test' via bash, then list files in (\S+)/i, run: (m) => [say("Checking that now."), tool({ command: "echo test" }), tool({ command: "ls " + m[1].replace(/[.,]$/, "") }), say("All done: it printed test and the directory is listed.")] },
  { name: "verbatim command once", re: /use the bash tool exactly once to run this exact command verbatim[^:]*:\s*(.+?)\nthen reply/is, run: (m) => [say("Running the command now."), tool({ command: m[1].trim() }, [say("It ran and finished.")], [say("It was blocked.")])] },
  // 4. queue/cancel: the first of two quick messages must still be running when the second arrives
  { name: "one word only", re: /reply with the word (\w+) only/i, run: (m) => [sleep(3000), say(m[1])] },
  // 5. the long streamed reply the reconnect test cuts in half
  { name: "count to N", re: /write the numbers 1 to (\d+)/i, run: (m) => [say(Array.from({ length: +m[1] }, (_, i) => i + 1).join("\n"), { chunk: 40, gapMs: 120 })] },
  // 6. memory: plant, and recall (the session transcript and the handoff seed both feed ctx.facts)
  { name: "remember", re: /remember this for later:.*?reply with one word:\s*(\w+)/is, run: (m) => [say(m[1])] },
  { name: "recall codeword", re: /what is the codeword/i, run: (_m, c) => [say(c.facts.codeword || "I don't have a codeword on record.")] },
  { name: "recall colour+codename", re: /what is my favou?rite colou?r and what is the project codename/i, run: (_m, c) => [say(c.facts.color && c.facts.codename ? `Your favorite color is ${c.facts.color} and the project codename is ${c.facts.codename}.` : "I don't have those on record.")] },
  // 7. vision: the upload test asks for the colour of a PNG's only pixel
  { name: "pixel colour", re: /what colou?r is the single pixel/i, run: (_m, c) => { const px = c.attachments.map(p => c.readImage(p)).find(Boolean); return [say(px ? colourName(px) : "I couldn't open the attachment.")]; } },
];

// Legacy scenario markers (test-bridge-turn.mjs): SCEN:<name> anywhere in the prompt picks a fixed behaviour. They win over the natural-language rules.
export const SCENARIOS = {
  ok: (c) => [say(`ok model=${c.model} mode=${c.mode}`), { type: "tool", name: "Bash", input: { command: "ls -la" }, canned: "file1\nfile2" }], // canned: no hook, no simulated shell
  env: (c) => [say(`JAMKEY=${c.env.JAM_KEY ? "present" : "absent"} role=${c.env.JAM_FROM_ROLE} host=${c.env.JAM_HOST ? "set" : "unset"}`)],
  "handoff-check": (c) => [say(`seed=${c.seed ? "yes" : "no"}`)],
};

export function plan(ctx) {
  if (ctx.scen) return (SCENARIOS[ctx.scen] || SCENARIOS.ok)(ctx); // crash-once / cap-once act in the CLI (they need files and an exit code); once past that they behave like ok
  for (const r of RULES) { const m = r.re.exec(ctx.text); if (m) return r.run(m, ctx); }
  const t = String(ctx.text || "").replace(/\s+/g, " ").trim();
  return [say(t ? `Fake claude heard: ${t.slice(0, 160)}${t.length > 160 ? "…" : ""}` : "Fake claude is here.")];
}

// Flatten the text a script says (what `result` carries) — branches excluded: they depend on a tool result, so the runner resolves them.
export const sayText = steps => steps.filter(s => s.type === "say").map(s => s.text).join("");
