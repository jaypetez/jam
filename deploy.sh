#!/bin/bash
# Rebuild + deploy the jam Worker. Uses wrangler if present, else the Cloudflare REST API with .env credentials.
set -e; cd "$(dirname "$0")"; ./build.sh
[ -f .env ] && set -a && . ./.env && set +a
[ -f .jam-key ] || { openssl rand -hex 24 > .jam-key; echo "generated .jam-key"; }
JK=$(cat .jam-key)
MIG=""; if [ -n "$JAM_MIGRATION" ]; then MIG=",\"migrations\":$JAM_MIGRATION"; fi
META=$(printf '{"main_module":"worker.js","compatibility_date":"2025-06-01","bindings":[{"type":"durable_object_namespace","name":"ROOM","class_name":"Room"},{"type":"durable_object_namespace","name":"HUB","class_name":"Hub"},{"type":"secret_text","name":"JAM_KEY","text":"%s"}]%s}' "$JK" "$MIG")
# Pre-upload bundle gate (validate-worker-bundle.cjs, vendored locally so jam deploys standalone — .cjs because jam's
# package.json is "type":"module" and the gate script is plain CommonJS) on the built worker.js against the same
# metadata the API path uploads (wrangler.toml declares the same DO bindings). Refuses on a parse error, a leaked
# key, a stale placeholder, or a DO binding whose class the bundle does not export.
# `./deploy.sh --check` = gate only, no deploy.
NODE_BIN=""; for c in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node /tmp/node-*/bin/node; do [ -x "$c" ] && { NODE_BIN="$c"; break; }; done
[ -n "$NODE_BIN" ] || { echo "no node runtime found for the bundle gate" >&2; exit 1; }
METAF=$(umask 077; mktemp); printf '%s' "$META" > "$METAF"
RC=0; "$NODE_BIN" validate-worker-bundle.cjs --metadata "$METAF" --label "${JAM_WORKER:-jam}" worker.js || RC=$?   # `|| RC=$?` so set -e cannot skip the rm below
rm -f "$METAF"
[ "$RC" -eq 0 ] || { echo "BUNDLE GATE FAILED — refusing to deploy." >&2; exit 1; }
if [ "${1:-}" = "--check" ]; then echo "--check: bundle gate passed. Not deploying."; exit 0; fi
# compute expected build hash (sha of ui.html + worker.src.js + budget.mjs, same as build.sh)
EXPECTED_HASH=$(cat ui.html worker.src.js budget.mjs | shasum -a 256 | cut -c1-10)
if command -v wrangler >/dev/null 2>&1 && [ -z "$JAM_FORCE_API" ]; then
  wrangler deploy
  printf '%s' "$JK" | wrangler secret put JAM_KEY
else
  : "${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID in .env}"
  AUTH=(); if [ -n "$CF_API_TOKEN" ]; then AUTH=(-H "Authorization: Bearer $CF_API_TOKEN"); else : "${CF_API_EMAIL:?}"; : "${CF_API_KEY:?}"; AUTH=(-H "X-Auth-Email: $CF_API_EMAIL" -H "X-Auth-Key: $CF_API_KEY"); fi
  API="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/scripts/${JAM_WORKER:-jam}"
  # Capture the response before piping to python3 — `curl | python3` alone masks a deploy failure because python3's
  # own exit code (0, it just prints) becomes the pipeline's exit code regardless of `success`. A prior version of
  # this script reported "deploy success False ..." to stdout and kept going anyway, letting setup.sh print
  # "Setup complete" over a worker that was never actually deployed.
  put_worker() { curl -s -X PUT "$API" "${AUTH[@]}" --form-string "metadata=$1" -F "worker.js=@worker.js;type=application/javascript+module"; }
  # A freshly deployed script has no workers.dev route by default — Cloudflare requires opting in per-script
  # (separate from the account's workers.dev subdomain slug existing at all). Without this, setup.sh prints a
  # lobby link that 404s (Cloudflare error 1042) until someone happens to enable it by hand in the dashboard.
  # Safe to call on every deploy: idempotent, and harmless even when a custom domain is also configured.
  enable_workers_dev() { curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/scripts/${JAM_WORKER:-jam}/subdomain" "${AUTH[@]}" -H "Content-Type: application/json" -d '{"enabled":true,"previews_enabled":false}' >/dev/null 2>&1 || true; }
  RESP=$(put_worker "$META")
  RC=0; printf '%s' "$RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('deploy success', d['success'], d.get('errors') or '')
if d['success']: sys.exit(0)
# code 10079: DO migration tag precondition failed — the classes already exist from an earlier deploy attempt
# (e.g. a retried setup.sh). Signal a retry without the migration payload rather than silently treating a
# rejected PUT as success: the worker.js on that first attempt was never actually uploaded.
sys.exit(79 if any(e.get('code') == 10079 for e in (d.get('errors') or [])) else 1)
" || RC=$?   # `|| RC=$?` so set -e cannot skip the retry/fail handling below
  if [ "$RC" -eq 79 ] && [ -n "$MIG" ]; then
    echo "  DO classes already exist — retrying deploy without the migration payload…"
    META_RETRY=$(printf '{"main_module":"worker.js","compatibility_date":"2025-06-01","bindings":[{"type":"durable_object_namespace","name":"ROOM","class_name":"Room"},{"type":"durable_object_namespace","name":"HUB","class_name":"Hub"},{"type":"secret_text","name":"JAM_KEY","text":"%s"}]}' "$JK")
    RESP=$(put_worker "$META_RETRY")
    printf '%s' "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('deploy success', d['success'], d.get('errors') or ''); sys.exit(0 if d['success'] else 1)" || { echo "DEPLOY FAILED — worker was not updated." >&2; exit 1; }
  elif [ "$RC" -ne 0 ]; then
    echo "DEPLOY FAILED — worker was not updated." >&2; exit 1
  fi
  enable_workers_dev
fi
# wait for Cloudflare propagation and verify the hash
if [ -n "$JAM_HOST" ]; then
  echo "verifying build hash at $JAM_HOST…"
  sleep 2
  for i in {1..10}; do LIVE_HASH=$(curl -s "https://$JAM_HOST/health" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('build',''))" 2>/dev/null || echo ""); [ "$LIVE_HASH" = "$EXPECTED_HASH" ] && { echo "✓ hash verified: $LIVE_HASH"; exit 0; }; [ $i -lt 10 ] && sleep 2; done
  echo "✗ build hash mismatch: expected $EXPECTED_HASH, got $LIVE_HASH (deploy may have failed or not yet propagated)" >&2
  exit 1
else
  echo "no JAM_HOST set; skipping hash verification (set JAM_HOST in .env or .github/workflows to verify)"
  exit 0
fi
