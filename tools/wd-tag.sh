#!/usr/bin/env bash
# Booru tags of an image, from the wd-tagger Space (https://huggingface.co/spaces/SmilingWolf/wd-tagger): the picture is uploaded to it.
#   tools/wd-tag.sh [-v] [-n] image.png   the tags, comma separated, on stdout, and copied to the clipboard (-n: not copied);
#                                         -v also gives the rating and each tag's confidence (those are not copied)
# The clipboard: wl-copy, xclip, xsel, pbcopy or clip.exe, the first one found that works. WD_COPY=0 is the same as -n.
# WD_MODEL     default SmilingWolf/wd-eva02-large-tagger-v3 (the most accurate; also wd-swinv2-tagger-v3, wd-vit-tagger-v3, ...)
# WD_GENERAL    general tags threshold, default 0.35        WD_CHARACTER   character tags threshold, default 0.85
# WD_URL        another Gradio server of the same app (default the Space)
# HF_TOKEN      optional, sent as the bearer token (more quota); never printed
set -euo pipefail

verbose=0
copy=${WD_COPY:-1}
while [ "${1:-}" = "-v" ] || [ "${1:-}" = "-n" ]; do
  if [ "$1" = "-v" ]; then verbose=1; else copy=0; fi
  shift
done
image="${1:?usage: tools/wd-tag.sh [-v] [-n] image.png}"
[ -f "$image" ] || { echo "no such file: $image" >&2; exit 2; }
for tool in curl jq; do command -v "$tool" >/dev/null || { echo "$tool is needed" >&2; exit 2; }; done

url="${WD_URL:-https://smilingwolf-wd-tagger.hf.space}"
model="${WD_MODEL:-SmilingWolf/wd-eva02-large-tagger-v3}"
auth=()
[ -n "${HF_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $HF_TOKEN")

# The Space can be asleep or busy for a moment: three tries, then the last error.
call() {
  local uploaded body event
  uploaded=$(curl -sS --fail --max-time 120 "${auth[@]}" -F "files=@$image" "$url/gradio_api/upload") || return 1
  body=$(jq -nc --arg path "$(jq -r '.[0]' <<<"$uploaded")" --arg model "$model" --argjson general "${WD_GENERAL:-0.35}" --argjson character "${WD_CHARACTER:-0.85}" \
    '{data: [{path: $path, meta: {_type: "gradio.FileData"}}, $model, $general, false, $character, false]}')
  event=$(curl -sS --fail --max-time 60 "${auth[@]}" -H 'content-type: application/json' -d "$body" "$url/gradio_api/call/predict" | jq -r '.event_id') || return 1
  # The answer comes as server-sent events: "event: complete" and then its "data: [...]" line, or "event: error".
  curl -sS --fail --max-time 180 "${auth[@]}" "$url/gradio_api/call/predict/$event" | awk '/^event: /{kind=$2} /^data: /{if (kind=="complete") {print substr($0, 7); exit} else if (kind=="error") {print "error " substr($0, 7) > "/dev/stderr"; exit 3}}'
}

result=""
for attempt in 1 2 3; do
  status=0
  result=$(call) || status=$?
  [ -n "$result" ] && break
  [ "$status" = 3 ] && exit 3 # the Space answered with an error (an unknown model, say): asking again will not change it
  [ "$attempt" -lt 3 ] && sleep $((attempt * 3))
done
[ -n "$result" ] || { echo "wd-tagger gave no answer (is $url up?)" >&2; exit 1; }

tags=$(jq -r '.[0]' <<<"$result")
printf '%s\n' "$tags"

# The tags are already on stdout: no clipboard tool, or one that fails (wl-copy without a Wayland session), is a note, not an error.
copy_to_clipboard() {
  local tool
  for tool in "wl-copy" "xclip -selection clipboard" "xsel --clipboard --input" "pbcopy" "clip.exe"; do
    command -v "${tool%% *}" >/dev/null || continue
    # shellcheck disable=SC2086 # the tool's arguments are meant to split
    if printf '%s' "$tags" | $tool 2>/dev/null; then
      echo "copied to the clipboard (${tool%% *})" >&2
      return 0
    fi
  done
  echo "not copied: none of wl-copy, xclip, xsel, pbcopy, clip.exe worked" >&2
}
[ "$copy" = 0 ] || copy_to_clipboard

if [ "$verbose" = 1 ]; then
  jq -r '"rating: " + .[1].label' <<<"$result"
  jq -r '.[3].confidences[] | "\(.label) \(.confidence * 100 | round / 100)"' <<<"$result"
fi
