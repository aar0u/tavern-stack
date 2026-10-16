#!/usr/bin/env bash
# pack-lite.sh [OUT]   build the package for a second SillyTavern (ST only, chat through this machine's gateway, no image generation) from
#                      this directory's own files, as OUT (default $SCRATCH/st-lite.tar.gz)
#
# Nothing in it is kept as a second copy: init.sh, merge-settings.mjs and the seed are the ones used here, except that the seed's settings
# lose the image generation (sd) and say settings.story.pictures is false, so that the 更多 menu offers only the summary; plus
# lite-README.txt (as README.txt), this directory's docker-compose.yml without the gateway service, and a .env with the state settings
# of a machine that keeps its data on disk. The seed's chat URL becomes http://$LLM_HOST:8789/v1; LLM_HOST comes from this directory's
# .env, default gateway.example (the deployed gateway on mc).
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
out="${1:-${SCRATCH:?SCRATCH must be set, or give the output file}/st-lite.tar.gz}"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
pkg="$stage/st-lite"
mkdir -p "$pkg/seed"

cp "$script_dir/init.sh" "$script_dir/merge-settings.mjs" "$pkg/"
cp -r "$script_dir/seed/scripts" "$script_dir/seed/QuickReplies" "$script_dir/seed/avatars" "$pkg/seed/"
cp "$script_dir/lite-README.txt" "$pkg/README.txt"
llm_host="$({ sed -n 's/^LLM_HOST=//p' "$script_dir/.env" 2>/dev/null || true; } | tail -n 1 | tr -d "'\"")"
llm_host="${llm_host:-gateway.example}"
printf 'ST_ROOT=./data\nST_RESTART=unless-stopped\n' > "$pkg/.env"
python3 -I - "$script_dir/docker-compose.yml" "$pkg/docker-compose.yml" <<'EOF'
import re, sys
lines = open(sys.argv[1], encoding="utf8").read().split("\n")
# The gateway service runs from its comment block (indent-2 comments just above) to the next indent-2 line.
start = lines.index("  gateway:")
while lines[start - 1].startswith("  #"):
    start -= 1
end = next(i for i in range(lines.index("  gateway:") + 1, len(lines)) if re.match(r"  \S", lines[i]))
lines[start:end] = []
text = "\n".join(lines)
assert "  gateway:" not in text
open(sys.argv[2], "w", encoding="utf8").write(text)
EOF
python3 -I - "$script_dir/seed/settings.json" "$pkg/seed/settings.json" "$llm_host" <<'EOF'
import json, sys
settings = json.load(open(sys.argv[1], encoding="utf8"))
# extra_hosts takes only IPs, so a host name (the default is one) goes into the chat URL instead.
settings["oai_settings"]["custom_url"] = f"http://{sys.argv[3]}:8789/v1"
del settings["extension_settings"]["sd"]
settings["extension_settings"]["story"]["pictures"] = False
json.dump(settings, open(sys.argv[2], "w", encoding="utf8"), ensure_ascii=False, indent=4)
EOF

mkdir -p "$(dirname "$out")"
tar -C "$stage" -czf "$out" st-lite
tar -tzf "$out"
echo "wrote $out"
