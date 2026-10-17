#!/usr/bin/env node
// Stand-in for the `claude` CLI for test-tenant.mjs only: answers each turn with what auth it was spawned with, so the test
// can prove a guest's turn gets JAM_DRIVER_API_KEY as ANTHROPIC_API_KEY, the host's own turn doesn't, and the raw var never leaks.
const [cmd, sub] = process.argv.slice(2);
if (cmd === "auth" && sub === "status") { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "stub@example.com", subscriptionType: "max" }) + "\n"); process.exit(0); }
if (!process.argv.includes("-p")) { process.stderr.write("stub: unsupported command\n"); process.exit(1); }
process.stdin.resume(); process.stdin.on("end", () => {
  const k = process.env.ANTHROPIC_API_KEY;
  const out = `TENANT-STUB key=${k ? k.slice(0, 7) : "unset"} leak=${process.env.JAM_DRIVER_API_KEY ? "yes" : "no"} role=${process.env.JAM_FROM_ROLE}`;
  const u = { input_tokens: 1, output_tokens: 1 };
  process.stdout.write(JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: out }], usage: u } }) + "\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: out, session_id: "stub-session", total_cost_usd: 0, usage: u, modelUsage: {} }) + "\n");
  process.exit(0);
});
