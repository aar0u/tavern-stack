#!/usr/bin/env bash
# deploy_to_mc.sh [ssh-host]   deploy SillyTavern and the gateway to a host that already runs leyline (default host: mc)
#
# The seed's sd.cpp backend points at port 7861 on the host; images work only while the PC's reverse tunnel is up:
#   ssh -N -R 7861:localhost:1234 HOST
# sshd binds that tunnel to the host's loopback only (GatewayPorts no), which containers cannot reach, so sd-relay below forwards
# 172.17.0.1:7861 to it.
# Every deployment resets the remote gateway.env to the host upstream on port 8317 without a key.
set -euo pipefail

HOST="${1:-mc}"
REMOTE_DIR="~/others/tavern-stack"
SD_TUNNEL_URL="http://host.docker.internal:7861"
DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
pkg="$stage/pkg"
mkdir -p "$pkg/seed"

cp "$DIR/init.sh" "$DIR/merge-settings.mjs" "$DIR/gateway.mjs" "$pkg/"
cp "$DIR/docker-compose.yml" "$pkg/"
# State on disk under ./data, restart with the host. SillyTavern's whitelist admits every IPv4 address (it refuses to start with the
# whitelist off): the Azure NSG decides who reaches ports 8000 and 8789 (the gateway, which lite packages use).
printf 'ST_ROOT=./data\nST_RESTART=unless-stopped\nST_LAN_CIDR=0.0.0.0/0\n' > "$pkg/.env"
cp -r "$DIR/seed/scripts" "$DIR/seed/QuickReplies" "$DIR/seed/avatars" "$pkg/seed/"
python3 -I - "$DIR/seed/settings.json" "$pkg/seed/settings.json" "$SD_TUNNEL_URL" <<'EOF'
import json, sys
settings = json.load(open(sys.argv[1], encoding="utf8"))
settings["extension_settings"]["sd"]["sdcpp_url"] = sys.argv[3]
json.dump(settings, open(sys.argv[2], "w", encoding="utf8"), ensure_ascii=False, indent=4)
EOF

tar -C "$pkg" -cf - . | ssh "$HOST" "mkdir -p $REMOTE_DIR && tar -C $REMOTE_DIR -xf -"

ssh "$HOST" "cd $REMOTE_DIR && bash -s" <<'EOF'
set -euo pipefail
printf 'UPSTREAM_URL=http://host.docker.internal:8317/v1\nUPSTREAM_KEY=\n' > gateway.env
echo "wrote gateway.env with UPSTREAM_URL=http://host.docker.internal:8317/v1"

docker rm -f sd-relay >/dev/null 2>&1 || true
docker run -d --name sd-relay --restart unless-stopped --network host alpine/socat \
  TCP-LISTEN:7861,bind=172.17.0.1,fork TCP:127.0.0.1:7861

# --force-recreate reruns st-init, so the seed is applied again.
docker compose up -d --force-recreate
sleep 3
docker logs --tail 5 gateway
docker ps --filter name=sillytavern --filter name=gateway --filter name=sd-relay --format '{{.Names}}\t{{.Status}}'
EOF
