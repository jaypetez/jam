#!/usr/bin/env node
// A stand-in for the `claude` CLI, for auth.test.mjs only: the real `claude auth login` opens a browser and mutates
// the host's credentials, which a test must never do. Understands just enough:
//   auth status                → {"loggedIn":…} from JAM_AUTH_STATE (a file, so the login below can flip it)
//   auth login                 → prints the sign-in URL, then waits on stdin for the code, like the real one
// Anything else exits 1: this stub never runs a turn.
import { readFileSync, writeFileSync } from "node:fs";
const stateFile = process.env.JAM_AUTH_STATE || "/tmp/jam-auth-state.json";
const read = () => { try { return JSON.parse(readFileSync(stateFile, "utf8")); } catch { return { loggedIn: false }; } };
const [cmd, sub] = process.argv.slice(2);

if (cmd === "auth" && sub === "status") {
  const s = read();
  process.stdout.write(JSON.stringify({ loggedIn: !!s.loggedIn, authMethod: "claude.ai", email: s.loggedIn ? "stub@example.com" : "", subscriptionType: s.loggedIn ? "max" : "" }) + "\n");
  process.exit(0);
}
if (cmd === "auth" && sub === "login") {
  if (process.env.JAM_AUTH_COUNT) { let n = 0; try { n = +readFileSync(process.env.JAM_AUTH_COUNT, "utf8") || 0; } catch {} writeFileSync(process.env.JAM_AUTH_COUNT, String(n + 1)); }
  process.stdout.write("Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=stub&state=stub\nPaste code here if prompted > ");
  let buf = "";
  process.stdin.on("data", d => {
    buf += d;
    if (!buf.includes("\n")) return;
    const code = buf.trim();
    if (code === process.env.JAM_AUTH_GOOD_CODE) { writeFileSync(stateFile, JSON.stringify({ loggedIn: true })); process.stdout.write("\nLogged in\n"); process.exit(0); }
    process.stderr.write("\nInvalid code\n"); process.exit(1);
  });
  setTimeout(() => process.exit(1), 120000);
} else { process.stderr.write("stub: unsupported command\n"); process.exit(1); }
