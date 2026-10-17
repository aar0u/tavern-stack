#!/usr/bin/env bash
# pack-mobile.sh [OUT]   package SillyTavern data, extensions, seed and a runner script for Termux (Android).
#                        Default OUT is $SCRATCH/st-mobile.tar.gz
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
out="${1:-${SCRATCH:?SCRATCH must be set, or give the output file}/st-mobile.tar.gz}"
if [ ! -f "$script_dir/gateway.mobile.env" ]; then
  echo "[ERROR] create gateway.mobile.env with UPSTREAM_URL and UPSTREAM_KEY for the phone's upstream; this file is ignored by Git" >&2
  exit 1
fi

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
pkg="$stage/st-mobile"
mkdir -p "$pkg/seed"

# 1. Copy runner and merge script from repo
cp "$script_dir/merge-settings.mjs" "$pkg/"
cp "$script_dir/gateway.mjs" "$pkg/"
cp "$script_dir/gateway.mobile.env" "$pkg/gateway.env"
# 2. Copy seed (sd settings point at the PC)
cp -r "$script_dir/seed/scripts" "$script_dir/seed/QuickReplies" "$script_dir/seed/avatars" "$pkg/seed/"
python3 -I - "$script_dir/seed/settings.json" "$pkg/seed/settings.json" <<'EOF'
import json, sys
settings = json.load(open(sys.argv[1], encoding="utf8"))
PC_HOST = "192.168.31.171"  # the PC that runs sd.cpp / ComfyUI; images work only while it is on
sd = settings.get("extension_settings", {}).get("sd", {})
for key, value in sd.items():
    if isinstance(value, str):
        sd[key] = value.replace("host.docker.internal", PC_HOST)
if "oai_settings" in settings:
    settings["oai_settings"]["custom_url"] = "http://127.0.0.1:8789/v1"
json.dump(settings, open(sys.argv[2], "w", encoding="utf8"), ensure_ascii=False, indent=4)
EOF

# 5. Generate Termux start script
cat > "$pkg/start.sh" << 'EOF'
#!/usr/bin/env bash
# SillyTavern Termux Runner
set -euo pipefail

BASE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ST_DIR="$BASE_DIR/SillyTavern"

echo "=== Checking environment ==="
if ! command -v node >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
  echo "Node.js or Git not found. Installing..."
  pkg update -y && pkg install -y nodejs-lts git
fi

# Clone SillyTavern if not present
if [ ! -d "$ST_DIR" ]; then
  echo "Cloning SillyTavern..."
  git clone --depth 1 https://github.com/SillyTavern/SillyTavern.git "$ST_DIR"
  (cd "$ST_DIR" && npm install --no-audit)
fi

USER_DATA="$ST_DIR/data/default-user"
mkdir -p "$USER_DATA" "$ST_DIR/plugins" "$ST_DIR/public/scripts/extensions/third-party"

# Install required extensions/plugins if missing
ext_dir="$ST_DIR/public/scripts/extensions/third-party"
plugin_dir="$ST_DIR/plugins"
for spec in \
  "$ext_dir=JS-Slash-Runner=https://github.com/N0VI028/JS-Slash-Runner.git" \
  "$ext_dir=ST-Prompt-Template=https://github.com/zonde306/ST-Prompt-Template.git" \
  "$ext_dir=story-oracle=https://github.com/namelessone88/story-oracle.git" \
  "$plugin_dir=SillyTavern-EdgeTTS-Plugin=https://github.com/SillyTavern/SillyTavern-EdgeTTS-Plugin.git"; do
  dir="${spec%%=*}"
  rest="${spec#*=}"
  name="${rest%%=*}"
  url="${rest#*=}"
  if [ ! -d "$dir/$name" ]; then
    echo "Installing $name..."
    git clone --depth 1 "$url" "$dir/$name" 2>/dev/null || echo "$name install failed (continuing)"
  fi
done

# Apply seed settings
if [ -f "$BASE_DIR/merge-settings.mjs" ] && [ -d "$BASE_DIR/seed" ]; then
  echo "Applying seed settings..."
  mkdir -p "$USER_DATA/QuickReplies" "$USER_DATA/User Avatars"
  cp -f "$BASE_DIR/seed/QuickReplies/"*.json "$USER_DATA/QuickReplies/" 2>/dev/null || true
  cp -f "$BASE_DIR/seed/avatars/"*.png "$USER_DATA/User Avatars/" 2>/dev/null || true
  node "$BASE_DIR/merge-settings.mjs" "$BASE_DIR/seed" "$USER_DATA/settings.json" "$ST_DIR/default/content/settings.json"
fi

# Optional: start gateway in background if gateway.env exists
if [ -f "$BASE_DIR/gateway.mjs" ] && [ -f "$BASE_DIR/gateway.env" ]; then
  echo "Starting gateway on port 8789..."
  pkill -f "node.*gateway.mjs" || true
  (
    set -a
    source "$BASE_DIR/gateway.env"
    set +a
    nohup node "$BASE_DIR/gateway.mjs" > "$BASE_DIR/gateway.log" 2>&1 &
  )
fi

if pkill -f "node server.js"; then
  echo "Stopped the SillyTavern that was already running"
  sleep 1
fi

echo "=== Starting SillyTavern ==="
echo "Access at: http://0.0.0.0:8000 (accessible from other devices on LAN)"
export SILLYTAVERN_LISTEN=true
export SILLYTAVERN_WHITELISTMODE=true
export SILLYTAVERN_WHITELIST='["127.0.0.1","::1","0.0.0.0/0"]'
export SILLYTAVERN_ENABLESERVERPLUGINS=true
cd "$ST_DIR"
exec node server.js --listen
EOF
chmod +x "$pkg/start.sh"

# 6. Archive
mkdir -p "$(dirname "$out")"
tar -C "$stage" -czf "$out" st-mobile
echo "=== Successfully built Termux package: $out ==="
echo "Package size: $(du -h "$out" | cut -f1)"
echo "Files included: $(tar -tzf "$out" | wc -l)"
