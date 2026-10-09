#!/bin/bash
# First-time setup: owner key, deploy, print links.
set -e; cd "$(dirname "$0")"
[ -f .env ] || { cp .env.example .env; echo "created .env — fill in CF_ACCOUNT_ID and CF_API_TOKEN if you are not using wrangler"; }
[ -f .jam-key ] || openssl rand -hex 24 > .jam-key

# Check for Claude auth (either Claude subscription or Anthropic API key)
if ! command -v claude >/dev/null 2>&1 && [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "⚠ Warning: Claude Code CLI not found in PATH, and ANTHROPIC_API_KEY is not set."
  echo "  You need at least one of:"
  echo "    • Claude Code CLI installed and logged in ('claude login')"
  echo "    • ANTHROPIC_API_KEY environment variable set (console.anthropic.com)"
  echo ""
  echo "  The bridge won't run without one. Set up your auth, then run ./setup.sh again."
  exit 1
fi

# Worker script name: JAM_WORKER env, else whatever's in wrangler.toml, else "jam"
[ -f .env ] && set -a && . ./.env && set +a
WORKER_NAME=${JAM_WORKER:-$(sed -n 's/^name = "\(.*\)"/\1/p' wrangler.toml)}
WORKER_NAME=${WORKER_NAME:-jam}

# Resolve the account's workers.dev subdomain — a human-chosen slug set once per account in the Cloudflare
# dashboard (e.g. "nullagency"), NOT the account ID — via the Cloudflare API, so the printed lobby link is
# correct instead of a guess. (A worker's default URL is <script>.<subdomain>.workers.dev.)
resolve_subdomain() {
  local acct="$1"
  [ -n "$acct" ] || return 1
  local auth=()
  if [ -n "$CF_API_TOKEN" ]; then auth=(-H "Authorization: Bearer $CF_API_TOKEN")
  elif [ -n "$CF_API_EMAIL" ] && [ -n "$CF_API_KEY" ]; then auth=(-H "X-Auth-Email: $CF_API_EMAIL" -H "X-Auth-Key: $CF_API_KEY")
  else return 1; fi
  curl -s "https://api.cloudflare.com/client/v4/accounts/$acct/workers/subdomain" "${auth[@]}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('subdomain','') or '')" 2>/dev/null
}

if command -v wrangler >/dev/null 2>&1; then
  ./deploy.sh
  ACCOUNT_ID=$(wrangler whoami 2>/dev/null | grep -oP '(?<=Account ID: )\w+' || echo "")
  if [ -z "$ACCOUNT_ID" ]; then
    ACCOUNT_ID=$(python3 -c "import json; d=json.load(open('.wrangler/state.json')); print(d.get('accounts', {}).get('*', {}).get('id', ''))" 2>/dev/null || echo "")
  fi
  SUBDOMAIN=$(resolve_subdomain "$ACCOUNT_ID")
else
  [ -n "$CF_ACCOUNT_ID" ] || { echo "No wrangler and no CF_ACCOUNT_ID in .env. Either 'npm i -g wrangler && wrangler login' or fill in .env with CF_ACCOUNT_ID and CF_API_TOKEN."; exit 1; }
  # first API deploy must create both DO classes
  JAM_MIGRATION='{"new_tag":"v1","new_sqlite_classes":["Room","Hub"]}' ./deploy.sh
  SUBDOMAIN=$(resolve_subdomain "$CF_ACCOUNT_ID")
fi

if [ -n "$SUBDOMAIN" ]; then
  JAM_HOST="$WORKER_NAME.$SUBDOMAIN.workers.dev"
  if ! grep -q "^JAM_HOST=" .env; then echo "JAM_HOST=$JAM_HOST" >> .env; fi
else
  echo "Could not auto-detect your workers.dev subdomain — set JAM_HOST manually in .env (Cloudflare dashboard → Workers & Pages → your worker → Settings → Domains)." >&2
fi

[ -f .env ] && set -a && . ./.env && set +a
HOST=${JAM_HOST:-""}
echo
if [ -n "$HOST" ]; then
  # Give Cloudflare a moment to propagate, then confirm the lobby actually answers before calling this done.
  OK=""
  for i in 1 2 3 4 5; do
    curl -sf "https://$HOST/health" >/dev/null 2>&1 && { OK=1; break; }
    sleep 2
  done
  if [ -n "$OK" ]; then
    echo "✓ Setup complete."
  else
    echo "⚠ Deployed, but https://$HOST/health isn't answering yet. It may just need a bit longer to propagate — try opening the lobby link in a minute. If it still fails, check the Worker in your Cloudflare dashboard."
  fi
  echo
  echo "  Lobby:  https://$HOST/?k=$(cat .jam-key)"
else
  echo "✓ Worker deployed, but the lobby URL could not be determined automatically."
  echo
  echo "  Find your Worker's URL in the Cloudflare dashboard (Workers & Pages → $WORKER_NAME), set it as JAM_HOST in .env, then re-run ./setup.sh."
fi
echo "  Bridge: ./run.sh   (keep it running on this machine)"
echo
echo "Open the lobby link in your browser, create a room, and invite people."
