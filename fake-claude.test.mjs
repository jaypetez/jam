#!/usr/bin/env node
// Tests for the fake claude: its pure rules (dev/fake-claude-rules.mjs) and the CLI itself (dev/fake-claude.mjs) driven the way the bridge drives
// `claude -p`. Plain Node, no framework (see CLAUDE.md). Nothing here needs a network, a login or wrangler.
import { parseInput, extractFacts, mergeFacts, handoffText, pngPixel, colourName, plan, sayText, BASE_CTX } from "./dev/fake-claude-rules.mjs";
import { spawnSync } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import zlib from "node:zlib";
let pass = 0, fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); } };
const ctxFor = (text, o = {}) => ({ text, from: "Ann", role: "owner", facts: {}, attachments: [], readImage: () => null, scen: null, model: "claude-sonnet-5", mode: "new", seed: null, env: {}, ...o });

// ── parseInput: the layout bridge.mjs builds
const NOTES = "[Room notes — durable memory for #r, kept at /x/notes.md and shown to you at the start of every turn. It's empty — nothing recorded yet.]\n\n---\n\n";
const SEED = "[Handoff from the previous session in this room, written by Claude when the context was compacted. Treat it as established context; do not repeat it back.]\n\nFacts: teal\n\n---\n\n";
eq("plain message", parseInput("[Mike]: hello there"), { from: "Mike", text: "hello there", seed: null, attachments: [], scen: null });
eq("notes block is stripped", parseInput(NOTES + "[Mike]: hi").text, "hi");
eq("handoff seed is extracted", [parseInput(NOTES + SEED + "[Mike]: hi").seed, parseInput(NOTES + SEED + "[Mike]: hi").text], ["Facts: teal", "hi"]);
eq("attachments footer is parsed off the text", parseInput("[Mike]: look\n\n[Attachments from Mike, saved on this machine: /a/b.png, /c d/e.png] — open them with the Read tool (images render).").attachments, ["/a/b.png", "/c d/e.png"]);
eq("…and the text excludes it", parseInput("[Mike]: look\n\n[Attachments from Mike, saved on this machine: /a/b.png] — open them").text, "look");
eq("windows attachment paths", parseInput("[Mike]: x\n\n[Attachments from Mike, saved on this machine: C:\\u\\a.png, D:\\b.png] — open").attachments, ["C:\\u\\a.png", "D:\\b.png"]);
eq("SCEN marker is found anywhere", parseInput("[Mike]: do SCEN:crash-once please").scen, "crash-once");
eq("no [from] prefix still yields text", parseInput("bare prompt").text, "bare prompt");

// ── memory
eq("facts: colour and codename", extractFacts("Remember this for later: my favorite color is teal and the project codename is Bluebird."), { color: "teal", codename: "Bluebird" });
eq("facts: codeword", extractFacts("the codeword is Marigold. Reply with one word: noted."), { codeword: "Marigold" });
eq("facts: nothing", extractFacts("hello"), {});
eq("facts: the handoff format round-trips", extractFacts(handoffText({ color: "teal", codename: "Bluebird", codeword: "Marigold" })), { color: "teal", codename: "Bluebird", codeword: "Marigold" });
eq("facts merge, later wins", mergeFacts({ color: "teal" }, { color: "red", codeword: "x" }, null), { color: "red", codeword: "x" });
{ const h = handoffText({ color: "teal", codename: "Bluebird" });
  eq("handoff carries the facts, is long enough for the bridge (200+ chars) and holds no key-shaped string", [/teal/.test(h) && /Bluebird/.test(h), h.length >= 200, /\b[0-9a-f]{48}\b/.test(h)], [true, true, false]);
  eq("a handoff with no facts still passes the length bar", handoffText({}).length >= 200, true); }

// ── png: build real PNGs of known colours and name them
const crc = (() => { const t = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }); return b => { let c = ~0; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; }; })();
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const mkPng = (ctype, pixelBytes, extra = []) => { const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = ctype; return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), ...extra, chunk("IDAT", zlib.deflateSync(Buffer.from([0, ...pixelBytes]))), chunk("IEND", Buffer.alloc(0))]); };
for (const [rgb, name] of [[[255, 0, 0], "red"], [[0, 200, 0], "green"], [[0, 0, 255], "blue"], [[255, 255, 0], "yellow"], [[255, 165, 0], "orange"], [[255, 255, 255], "white"], [[0, 0, 0], "black"], [[128, 128, 128], "gray"], [[255, 105, 180], "pink"], [[128, 0, 128], "purple"], [[0, 255, 255], "cyan"]])
  eq(`RGB png ${rgb} is ${name}`, colourName(pngPixel(mkPng(2, rgb), zlib.inflateSync)), name);
eq("RGBA png", pngPixel(mkPng(6, [10, 20, 30, 255]), zlib.inflateSync), [10, 20, 30]);
eq("greyscale png", pngPixel(mkPng(0, [200]), zlib.inflateSync), [200, 200, 200]);
eq("palette png", pngPixel(mkPng(3, [1], [chunk("PLTE", Buffer.from([0, 0, 0, 255, 0, 0]))]), zlib.inflateSync), [255, 0, 0]);
eq("garbage is not a png", [pngPixel(Buffer.from("nope"), zlib.inflateSync), pngPixel(null, zlib.inflateSync)], [null, null]);
eq("a corrupt IDAT is null, not a throw", pngPixel(Buffer.concat([mkPng(2, [1, 2, 3]).subarray(0, 41), Buffer.from("junk")]), zlib.inflateSync), null);

// ── the rules, by the exact prompts the live tests send
eq("PONG", sayText(plan(ctxFor("Reply with exactly the single word PONG and nothing else."))), "PONG");
{ const s = plan(ctxFor("Run this exact bash command and tell me the result: git push origin does-not-exist-branch")); const t = s.find(x => x.type === "tool");
  eq("approval prompt → a Bash tool call of that exact command", [t.name, t.input.command], ["Bash", "git push origin does-not-exist-branch"]);
  eq("…with a branch for allowed and one for blocked", [sayText(t.ok), sayText(t.blocked)], ["It ran. Here is what it printed.", "That command was blocked, so I did not run it."]); }
{ const t = plan(ctxFor("Use the Bash tool to run: echo jam-tool-check. Then reply DONE.")).find(x => x.type === "tool"); eq("tool-card prompt", [t.input.command, sayText(t.ok)], ["echo jam-tool-check", "DONE"]); }
{ const t = plan(ctxFor("Use Bash to run: ls /tmp/jamtest. Reply with the word OK.")).find(x => x.type === "tool"); eq("harmless-command prompt", [t.input.command, sayText(t.ok)], ["ls /tmp/jamtest", "OK"]); }
{ const s = plan(ctxFor("Reply with the word FIRST only.")); eq("queue prompt: takes time first (so a second message can queue), then answers", [s[0].type, s[0].ms >= 2000, sayText(s)], ["sleep", true, "FIRST"]); }
{ const s = plan(ctxFor("Run 'echo test' via Bash, then list files in /tmp/jam-test-status-bar, then tell me the result. Be brief.")); eq("multi-tool prompt: two tools", s.filter(x => x.type === "tool").map(x => x.input.command), ["echo test", "ls /tmp/jam-test-status-bar"]); }
{ const cmd = `sleep 4 && node browser.mjs '[{"action":"goto","url":"https://example.com"}]'`; const t = plan(ctxFor(`Use the Bash tool exactly once to run this exact command verbatim (do not use TodoWrite for this, just run it): ${cmd}\nThen reply in one short sentence with what happened.`)).find(x => x.type === "tool"); eq("status-bar repro prompt: the command is taken verbatim", t.input.command, cmd); }
{ const s = plan(ctxFor("Write the numbers 1 to 400, one per line, no commentary, no code block.")); const t = s[0].text.split("\n"); eq("long reply: 400 lines, streamed slowly in chunks", [t.length, t[0], t[399], s[0].chunk > 0, s[0].gapMs > 0], [400, "1", "400", true, true]); }
eq("remember → one word", sayText(plan(ctxFor("Remember this for later: my favorite color is teal and the project codename is Bluebird. Reply with one word: noted."))), "noted");
eq("recall colour and codename from memory", sayText(plan(ctxFor("What is my favorite color and what is the project codename? One line.", { facts: { color: "teal", codename: "Bluebird" } }))), "Your favorite color is teal and the project codename is Bluebird.");
eq("…and says so honestly when it has nothing", sayText(plan(ctxFor("What is my favorite color and what is the project codename? One line."))), "I don't have those on record.");
eq("recall codeword", sayText(plan(ctxFor("What is the codeword? One word.", { facts: { codeword: "Marigold" } }))), "Marigold");
eq("pixel colour reads the attachment", sayText(plan(ctxFor("What colour is the single pixel in the attached PNG? Answer with one word.", { attachments: ["/x.png"], readImage: () => [255, 0, 0] }))), "red");
eq("…and admits when it cannot open it", sayText(plan(ctxFor("What colour is the single pixel in the attached PNG?", { attachments: ["/x.png"] }))), "I couldn't open the attachment.");
eq("unknown prompts get an echo, so `npm run dev` feels alive", sayText(plan(ctxFor("hello robots"))), "Fake claude heard: hello robots");
eq("long unknown prompts are truncated", sayText(plan(ctxFor("x".repeat(300)))).length < 200, true);
eq("scenario markers win over rules", sayText(plan(ctxFor("Reply with exactly the single word PONG SCEN:handoff-check", { scen: "handoff-check", seed: "s" }))), "seed=yes");
eq("a SCEN that acts in the CLI (cap-once, crash-once) behaves like ok once past its fault", sayText(plan(ctxFor("x", { scen: "cap-once", model: "m", mode: "resume" }))), "ok model=m mode=resume");
eq("SCEN:env reports the environment the turn really had", sayText(plan(ctxFor("x", { scen: "env", env: { JAM_FROM_ROLE: "driver", JAM_HOST: "h" } }))), "JAMKEY=absent role=driver host=set");
eq("baseline context is a realistic first turn (the switch test needs 15-16k)", BASE_CTX > 15000 && BASE_CTX < 16000, true);

// ── the CLI, driven like the bridge drives claude -p
const FAKE = path.resolve("dev/fake-claude.mjs"), HOOK_ENV = { JAM_FROM_ROLE: "owner" };
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"))); const home = path.join(root, "home"); fs.mkdirSync(home);
const mkcwd = n => { const d = path.join(root, n); fs.mkdirSync(d); return d; };
const run = (args, input, { cwd, env } = {}) => spawnSync(process.execPath, [FAKE, ...args], { input, cwd: cwd || root, encoding: "utf8", timeout: 60000, env: { ...process.env, HOME: home, USERPROFILE: home, ...HOOK_ENV, ...env } });
const events = r => r.stdout.split("\n").filter(Boolean).map(l => JSON.parse(l));
const result = r => events(r).find(e => e.type === "result");
const A = ["-p", "--output-format", "stream-json", "--model", "claude-sonnet-5"];
const transcript = (cwd, id) => path.join(home, ".claude", "projects", path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-"), id + ".jsonl");

eq("auth status answers like the real CLI", JSON.parse(run(["auth", "status"], "").stdout), { loggedIn: true, authMethod: "claude.ai", email: "fake@example.com", subscriptionType: "max" });
eq("anything but -p is refused", run(["chat"], "").status, 1);
{ const cwd = mkcwd("a"); const r = run([...A, "--session-id", "s1"], "[Ann]: Reply with exactly the single word PONG and nothing else.", { cwd }); const res = result(r);
  eq("a turn streams text and finishes with a result", [r.status, res.result, res.is_error, res.usage.input_tokens > 15000], [0, "PONG", false, true]);
  eq("…reports the model in modelUsage (the bridge reads the window from it)", res.modelUsage["claude-sonnet-5"].contextWindow, 200000);
  eq("…and writes the session transcript the bridge looks for", fs.existsSync(transcript(cwd, "s1")), true);
  const r2 = run([...A, "--resume", "s1"], "[Ann]: hello again", { cwd }); eq("resuming that session works", [r2.status, result(r2).is_error], [0, false]);
  eq("…and the transcript grows with each turn", fs.readFileSync(transcript(cwd, "s1"), "utf8").split("\n").filter(Boolean).length >= 4, true);
  eq("context grows with the session", result(r2).usage.input_tokens >= res.usage.input_tokens, true); }
{ const cwd = mkcwd("b"); const r = run([...A, "--resume", "never-existed"], "[Ann]: hi", { cwd }); eq("--resume of an unknown session fails like the real CLI (the bridge's retry path depends on it)", [r.status, /No conversation found with session ID: never-existed/.test(r.stderr)], [1, true]); }
{ const cwd = mkcwd("c"); const r = run([...A, "--session-id", "tc"], "[Ann]: Use the Bash tool to run: echo jam-tool-check. Then reply DONE.", { cwd }); const ev = events(r);
  const tu = ev.find(e => e.type === "assistant")?.message.content[0], tr = ev.find(e => e.type === "user")?.message.content[0];
  eq("a tool call goes through the real hook (owner: allowed) and the simulated shell", [tu.name, tu.input.command, tr.is_error, tr.content, result(r).result], ["Bash", "echo jam-tool-check", false, "jam-tool-check", "Running that.DONE"]); }
{ const cwd = mkcwd("d"); fs.writeFileSync(path.join(cwd, "keep.txt"), "x"); const r = run([...A, "--session-id", "sh"], `[Ann]: Use Bash to run: rm -rf ${cwd}. Reply with the word OK.`, { cwd }); const tr = events(r).find(e => e.type === "user")?.message.content[0];
  eq("SAFETY: a destructive command is not executed, only reported as not simulated", [fs.existsSync(path.join(cwd, "keep.txt")), tr.is_error, /not simulated/.test(tr.content)], [true, true, true]);
  const r2 = run([...A, "--session-id", "sh2"], `[Ann]: Use Bash to run: echo a && rm -rf ${cwd}. Reply with the word OK.`, { cwd }); eq("…also when chained behind a harmless one", fs.existsSync(path.join(cwd, "keep.txt")), true);
  const r3 = run([...A, "--session-id", "sh3"], `[Ann]: Use Bash to run: ls ${cwd}. Reply with the word OK.`, { cwd }); eq("ls is simulated for real", events(r3).find(e => e.type === "user").message.content[0].content.includes("keep.txt"), true); }
{ const cwd = mkcwd("e"); const r = run([...A, "--session-id", "bl"], "[Dee]: Run this exact bash command and tell me the result: git push origin nope", { cwd, env: { JAM_FROM_ROLE: "driver", JAM_HOST: "", JAM_KEY: "", JAM_ROOM: "" } });
  const tr = events(r).find(e => e.type === "user")?.message.content[0]; eq("a risky driver call the hook refuses (no room to ask → fail closed) is reported as blocked, and the turn still finishes", [tr.is_error, result(r).result], [true, "Running it now.That command was blocked, so I did not run it."]); }
{ const cwd = mkcwd("f"); run([...A, "--session-id", "mem"], "[Ann]: Remember this for later: my favorite color is teal and the project codename is Bluebird. Reply with one word: noted.", { cwd });
  const h = result(run(["-p", "--output-format", "json", "--model", "claude-sonnet-5", "--resume", "mem"], "You are about to be compacted...", { cwd }));
  eq("compaction in resume mode writes the handoff from the session's own memory", [/teal/.test(h.result), /Bluebird/.test(h.result), h.result.length >= 200, h.is_error], [true, true, true, false]);
  const t = result(run(["-p", "--output-format", "json", "--model", "claude-sonnet-5", "--tools", ""], "<transcript>\nUSER: [Mike]: the codeword is Marigold\n</transcript>", { cwd: mkcwd("g") }));
  eq("compaction from a transcript finds the facts in it", /Marigold/.test(t.result), true);
  const seeded = SEED.replace("Facts: teal", "Facts to carry over: favorite color: teal; project codename: Bluebird.");
  const a = result(run([...A, "--session-id", "fresh"], seeded + "[Ann]: What is my favorite color and what is the project codename? One line.", { cwd: mkcwd("h") }));
  eq("a fresh session answers from the handoff seed it was given", a.result, "Your favorite color is teal and the project codename is Bluebird."); }
{ const cwd = mkcwd("i"); const r = run([...A, "--session-id", "co"], "[Ann]: x SCEN:cap-once", { cwd }); const res = result(r); const r2 = run([...A, "--session-id", "co"], "[Ann]: x SCEN:cap-once", { cwd });
  eq("SCEN:cap-once is capped the first time, fine the second", [res.is_error, /usage limit/.test(res.result), result(r2).is_error], [true, true, false]);
  const c1 = run([...A, "--session-id", "cr"], "[Ann]: SCEN:crash-once", { cwd }), c2 = run([...A, "--session-id", "cr"], "[Ann]: SCEN:crash-once", { cwd });
  eq("SCEN:crash-once dies with no result the first time, fine the second", [c1.status, result(c1), c2.status, result(c2).is_error], [1, undefined, 0, false]);
  const calls = fs.readFileSync(path.join(cwd, ".calls"), "utf8").trim().split("\n").map(l => JSON.parse(l)); eq("every call is recorded in .calls for the bridge tests", [calls.length, calls[0].model, calls[0].mode], [4, "claude-sonnet-5", "new"]); }
{ const cwd = mkcwd("j"); const r = run([...A, "--session-id", "img"], `[Ann]: What colour is the single pixel in the attached PNG? Answer with one word.\n\n[Attachments from Ann, saved on this machine: ${path.join(cwd, "dot.png")}] — open them with the Read tool (images render).`, { cwd });
  fs.writeFileSync(path.join(cwd, "dot.png"), mkPng(2, [255, 0, 0])); const r2 = run([...A, "--session-id", "img2"], `[Ann]: What colour is the single pixel in the attached PNG? Answer with one word.\n\n[Attachments from Ann, saved on this machine: ${path.join(cwd, "dot.png")}] — open them with the Read tool (images render).`, { cwd });
  eq("a missing attachment is admitted; a real one is actually decoded", [result(r).result, result(r2).result], ["I couldn't open the attachment.", "red"]); }

fs.rmSync(root, { recursive: true, force: true });
console.log(`fake-claude: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
