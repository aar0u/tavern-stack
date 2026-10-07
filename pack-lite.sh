#!/usr/bin/env bash
# pack-lite.sh [OUT]   build the package for a second SillyTavern (ST only, chat through this machine's gateway, no image generation) from
#                      this directory's own files, as OUT (default $SCRATCH/st-lite.tar.gz)
#
# Nothing in it is kept as a second copy: init.sh, merge-settings.mjs and the seed are the ones used here, except that the seed's settings
# lose the image generation (sd) and say settings.story.pictures is false, so that the 更多 menu offers only the summary; plus
# docker-compose.lite.yml (as docker-compose.yml) and lite-README.txt (as README.txt), and a .env with the LLM_HOST of this directory's .env
# (the address of this machine, which is not kept in any committed file).
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
out="${1:-${SCRATCH:?SCRATCH must be set, or give the output file}/st-lite.tar.gz}"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
pkg="$stage/st-lite"
mkdir -p "$pkg/seed"

cp "$script_dir/init.sh" "$script_dir/merge-settings.mjs" "$pkg/"
cp -r "$script_dir/seed/scripts" "$script_dir/seed/QuickReplies" "$pkg/seed/"
cp "$script_dir/docker-compose.lite.yml" "$pkg/docker-compose.yml"
cp "$script_dir/lite-README.txt" "$pkg/README.txt"
llm_host="$({ sed -n 's/^LLM_HOST=//p' "$script_dir/.env" 2>/dev/null || true; } | tail -n 1 | tr -d "'\"")"
[ -n "$llm_host" ] || { echo "pack-lite.sh: LLM_HOST (the address of this machine) is not set in $script_dir/.env" >&2; exit 1; }
printf 'LLM_HOST=%s\n' "$llm_host" > "$pkg/.env"
python3 -I - "$script_dir/seed/settings.json" "$pkg/seed/settings.json" <<'EOF'
import json, sys
settings = json.load(open(sys.argv[1], encoding="utf8"))
del settings["extension_settings"]["sd"]
settings["extension_settings"]["story"]["pictures"] = False
json.dump(settings, open(sys.argv[2], "w", encoding="utf8"), ensure_ascii=False, indent=4)
EOF

mkdir -p "$(dirname "$out")"
tar -C "$stage" -czf "$out" st-lite
tar -tzf "$out"
echo "wrote $out"
