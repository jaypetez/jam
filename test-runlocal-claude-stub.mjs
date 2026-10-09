#!/usr/bin/env node
// Stand-in for the `claude` CLI for runlocal.test.mjs only. It does what Claude Code does at a tool call: runs the REAL approve hook
// (PreToolUse) with the environment THIS process was spawned with, and reports each exit code as the turn's answer. JAM_HOST is blanked
// for the hook so a call that would raise an Allow card dies at once ("no room to ask", exit 2) instead of waiting 10 minutes.
import { spawnSync } from "node:child_process";
import path from "node:path"; import { fileURLToPath } from "node:url";
const [cmd, sub] = process.argv.slice(2);
if (cmd === "auth" && sub === "status") { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "stub@example.com", subscriptionType: "max" }) + "\n"); process.exit(0); }
if (!process.argv.includes("-p")) { process.stderr.write("stub: unsupported command\n"); process.exit(1); }
const hook = path.join(path.dirname(fileURLToPath(import.meta.url)), "approve-hook.mjs");
const probe = c => spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: c } }), encoding: "utf8", env: { ...process.env, JAM_HOST: "" } }).status;
let stdin = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", d => stdin += d);
process.stdin.on("end", () => {
  const out = `HOOKS node=${probe("node build.js")} rm=${probe("rm -rf ./dist")} ctl=${probe("cat ~/.jam-key")} role=${process.env.JAM_FROM_ROLE} flag=${process.env.JAM_RUN_LOCAL || "unset"}`;
  const u = { input_tokens: 1, output_tokens: 1 };
  process.stdout.write(JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: out }], usage: u } }) + "\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: out, session_id: "stub-session", total_cost_usd: 0, usage: u, modelUsage: {} }) + "\n");
  process.exit(0);
});
