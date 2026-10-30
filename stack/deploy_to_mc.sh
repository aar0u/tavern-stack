#!/usr/bin/env bash
# deploy_to_mc.sh [ssh-host]   deploy SillyTavern and the gateway to a host that already runs leyline (default host: mc)
#
# LAN_HOST: the address of the host that runs the LLM API (port 3425) and the image backend (port 1234); default 192.168.31.217, or set
#   it in the environment. The deployed seed and gateway.env use it in place of the seed's host.docker.internal defaults.
# The gateway is kept but unused: to go through it, set the chat URL to http://gateway:8789/v1.
set -euo pipefail

HOST="${1:-mc}"
LAN_HOST="${LAN_HOST:-192.168.31.217}"
REMOTE_DIR="~/others/tavern-stack"
DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
pkg="$stage/pkg"
mkdir -p "$pkg/seed"

cp "$DIR/init.sh" "$DIR/merge-settings.mjs" "$DIR/gateway.mjs" "$DIR/docker-compose.yml" "$pkg/"
# State on disk under ./data, restart with the host. SillyTavern's whitelist admits every IPv4 address (it refuses to start with the
# whitelist off): the Azure NSG decides who reaches ports 8000 and 8789 (the gateway).
printf 'ST_ROOT=./data\nST_RESTART=unless-stopped\nST_LAN_CIDR=0.0.0.0/0\n' > "$pkg/.env"
printf 'UPSTREAM_URL=http://%s:3425/v1\nUPSTREAM_KEY=\n' "$LAN_HOST" > "$pkg/gateway.env"
cp -r "$DIR/seed/scripts" "$DIR/seed/avatars" "$pkg/seed/"
python3 -I - "$DIR/seed/settings.json" "$pkg/seed/settings.json" "$LAN_HOST" <<'EOF'
import json, sys
settings = json.load(open(sys.argv[1], encoding="utf8"))
host = sys.argv[3]
settings["oai_settings"]["custom_url"] = f"http://{host}:3425/v1"
settings["extension_settings"]["storyOracle"]["endpoint"] = f"http://{host}:3425/v1"
settings["extension_settings"]["sd"]["sdcpp_url"] = f"http://{host}:1234"
json.dump(settings, open(sys.argv[2], "w", encoding="utf8"), ensure_ascii=False, indent=4)
EOF

tar -C "$pkg" -cf - . | ssh "$HOST" "mkdir -p $REMOTE_DIR && tar -C $REMOTE_DIR -xf -"

ssh "$HOST" "cd $REMOTE_DIR && bash -s" <<'EOF'
set -euo pipefail
# --force-recreate reruns st-init, so the seed is applied again.
docker compose up -d --force-recreate
sleep 3
docker logs --tail 5 gateway
docker ps --filter name=sillytavern --filter name=gateway --format '{{.Names}}\t{{.Status}}'
EOF
