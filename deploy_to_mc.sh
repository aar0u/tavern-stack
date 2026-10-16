#!/usr/bin/env bash
# deploy_to_mc.sh [ssh-host]   deploy SillyTavern and the gateway to a host that already runs leyline (default host: mc)
#
# Like pack-mobile.sh, the seed's image backends (sd) point at the PC instead of host.docker.internal; images work only while it is on.
# The remote .gateway.env is never overwritten. On the first deploy it is created with UPSTREAM_URL set to leyline's published port.
set -euo pipefail

HOST="${1:-mc}"
REMOTE_DIR="~/others/tavern-stack"
PC_HOST="192.168.31.171"  # the PC that runs sd.cpp / ComfyUI
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
# MODEL and BODY of the local .gateway.env seed the remote one on the first deploy; the key and the upstream address stay behind.
{ grep -E '^(MODEL|BODY)=' "$DIR/.gateway.env" 2>/dev/null || true; } > "$pkg/.gateway.env.defaults"
cp -r "$DIR/seed/scripts" "$DIR/seed/QuickReplies" "$DIR/seed/avatars" "$pkg/seed/"
python3 -I - "$DIR/seed/settings.json" "$pkg/seed/settings.json" "$PC_HOST" <<'EOF'
import json, sys
settings = json.load(open(sys.argv[1], encoding="utf8"))
sd = settings.get("extension_settings", {}).get("sd", {})
for key, value in sd.items():
    if isinstance(value, str):
        sd[key] = value.replace("host.docker.internal", sys.argv[3])
json.dump(settings, open(sys.argv[2], "w", encoding="utf8"), ensure_ascii=False, indent=4)
EOF

tar -C "$pkg" -cf - . | ssh "$HOST" "mkdir -p $REMOTE_DIR && tar -C $REMOTE_DIR -xf -"

ssh "$HOST" "cd $REMOTE_DIR && bash -s" <<'EOF'
set -euo pipefail
if [ ! -f .gateway.env ]; then
  port="$(docker port leyline 2>/dev/null | sed -n 's/.*:\([0-9]*\)$/\1/p' | head -n1)"
  if [ -z "$port" ]; then
    echo "[ERROR] no .gateway.env here and leyline has no published port; create $PWD/.gateway.env (UPSTREAM_URL, MODEL, BODY) and rerun" >&2
    exit 1
  fi
  { printf 'UPSTREAM_URL=http://host.docker.internal:%s/v1\n' "$port"; cat .gateway.env.defaults; } > .gateway.env
  echo "created .gateway.env with UPSTREAM_URL=http://host.docker.internal:$port/v1 and the local MODEL and BODY"
  grep -q '^MODEL=' .gateway.env || echo "[WARN] no MODEL in the local .gateway.env: set MODEL in $PWD/.gateway.env, or ST sends 'default' and the upstream answers 400" >&2
fi

# --force-recreate reruns st-init, so the seed is applied again.
docker compose up -d --force-recreate
sleep 3
docker logs --tail 5 gateway
docker ps --filter name=sillytavern --filter name=gateway --format '{{.Names}}\t{{.Status}}'
EOF
