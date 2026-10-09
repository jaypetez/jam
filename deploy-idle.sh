#!/bin/bash
# Deploy the Worker only once no Claude turn is running on this host — a deploy recycles the room's Durable Object
# and drops every socket, so shipping mid-turn is how replies go missing. Usage: ./deploy-idle.sh (blocks) or
# nohup ./deploy-idle.sh & (fires after the current turn ends). Extra args are passed to deploy.sh.
cd "$(dirname "$0")"
# Only the bridge's own turns count — every jam child runs with --settings ~/.jam/settings.json. Matching any
# claude --resume on the host blocked deploys for hours whenever a desktop Claude Code window was open.
# ps, not pgrep: macOS pgrep hides its own ancestors, so a check launched from inside a jam turn saw nothing and
# deployed mid-turn.
busy() { ps -axo command= | grep -- "--settings $HOME/.jam/settings.json" | grep -qv grep; }
while busy; do sleep 3; done
exec ./deploy.sh "$@"
