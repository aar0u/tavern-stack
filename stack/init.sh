#!/bin/sh
# One-shot init run by the st-init service, before SillyTavern starts: installs extensions/plugins, then applies ./seed.
set -eu

ext_dir="${ST_EXT_DIR:-/home/node/app/public/scripts/extensions/third-party}"
plugin_dir="${ST_PLUGIN_DIR:-/home/node/app/plugins}"

# dir=name=url; a failed clone must not block SillyTavern from starting.
# SillyTavern-EdgeTTS-Plugin is the server side of the TTS "Edge" provider (needs enableServerPlugins).
# tavern-stack is this repository: its root is the extension; this directory (stack/) comes along in the clone and the extension ignores it.
for spec in \
  "$ext_dir=JS-Slash-Runner=https://github.com/N0VI028/JS-Slash-Runner.git" \
  "$ext_dir=ST-Prompt-Template=https://github.com/zonde306/ST-Prompt-Template.git" \
  "$ext_dir=story-oracle=https://github.com/namelessone88/story-oracle.git" \
  "$ext_dir=tavern-stack=https://github.com/aar0u/tavern-stack.git" \
  "$plugin_dir=SillyTavern-EdgeTTS-Plugin=https://github.com/SillyTavern/SillyTavern-EdgeTTS-Plugin.git"; do
  dir="${spec%%=*}"
  rest="${spec#*=}"
  name="${rest%%=*}"
  url="${rest#*=}"
  if [ -d "$dir/$name" ]; then
    echo "$name: already installed"
  elif git clone --depth 1 "$url" "$dir/$name"; then
    echo "$name: installed"
  else
    echo "$name: install failed (continuing)" >&2
  fi
done

app_dir="${ST_APP_DIR:-/home/node/app}"
user_dir="$app_dir/data/default-user"
seed_dir="${ST_SEED_DIR:-/seed}"

# Seed files overwrite their counterparts in the data dir on every start; edit them in the repo, not in the UI.
mkdir -p "$user_dir/QuickReplies" "$user_dir/User Avatars"
cp -f "$seed_dir"/QuickReplies/*.json "$user_dir/QuickReplies/"
cp -f "$seed_dir"/avatars/*.png "$user_dir/User Avatars/"
exec node "${ST_MERGE_SETTINGS:-/merge-settings.mjs}" "$seed_dir" "$user_dir/settings.json" "$app_dir/default/content/settings.json"
