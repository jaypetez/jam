#!/usr/bin/env node
// `npm run dev`: the whole jam stack on this machine, in one command, touching nothing that exists already.
//   - the REAL Worker on workerd (real Durable Objects), http://127.0.0.1:<free port>
//   - a REAL bridge against it, answering with the deterministic fake claude (or your own claude with --real)
//   - a demo room plus owner / driver / viewer links, all state in one throwaway directory
// Ctrl-C tears everything down. Flags:  --real   use the host's real `claude` (spends quota, needs a login)
//                                       --keep   keep the throwaway state directory afterwards (logs live in <dir>/logs)
//                                       --room <name>   name of the demo room (default: demo)
import fs from "node:fs"; import path from "node:path";
import { startStack, sleep } from "./stack.mjs";

const args = process.argv.slice(2);
const flag = f => args.includes(f), val = (f, d) => { const i = args.indexOf(f); return i > -1 && args[i + 1] ? args[i + 1] : d; };
const real = flag("--real"), keep = flag("--keep"), roomName = val("--room", "demo");

let stack;
try { stack = await startStack({ keep, quiet: true }); }
catch (e) { console.error("jam dev: " + e.message); process.exit(1); }

const work = path.join(stack.dir, "work", roomName); fs.mkdirSync(work, { recursive: true });
const bridge = stack.startBridge({ claude: real ? "real" : "fake" });
await stack.api("/rooms", { method: "POST", body: { name: roomName, cwd: work } });
const mk = async (role, name) => (await stack.api(`/rooms/${roomName}/invites`, { method: "POST", body: { role, name } })).data.token;
const [drv, vw] = [await mk("driver", "Dee"), await mk("viewer", "Sam")];

const bold = s => `\x1b[1m${s}\x1b[0m`, dim = s => `\x1b[2m${s}\x1b[0m`;
console.log(`
${bold("jam dev")}  ${dim(`(build ${stack.hash}, ${real ? "real claude" : "fake claude"})`)}

  lobby    ${stack.url}/?k=${stack.key}
  room     ${stack.url}/r/${roomName}?k=${stack.key}            ${dim("you, as owner")}
  driver   ${stack.url}/j/${drv}              ${dim("Dee: talks to Claude, risky calls need your approval")}
  viewer   ${stack.url}/j/${vw}              ${dim("Sam: watches")}

  state    ${stack.dir}${keep ? "" : dim("   (deleted on exit; --keep to keep)")}
${real ? "" : `  ${dim("The fake claude answers from a script: try  SCEN:ok  SCEN:env  SCEN:crash-once  SCEN:cap-once  in a message.")}\n`}  ${dim("Ctrl-C stops everything.")}
`);

// stream the bridge's log until we are told to stop
let shown = 0;
const pump = setInterval(() => { const out = bridge.output(); if (out.length > shown) { process.stdout.write(out.slice(shown).split("\n").filter(Boolean).map(l => dim("bridge  ") + l).join("\n") + "\n"); shown = out.length; } if (bridge.child.exitCode !== null) { console.error("the bridge exited; stopping"); stop(1); } }, 400);
let stopping = false;
async function stop(code = 0) { if (stopping) return; stopping = true; clearInterval(pump); console.log("\nstopping the stack..."); await stack.stop(); process.exit(code); }
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => stop(0));
await new Promise(() => {}); // run until a signal
void sleep;
