#!/usr/bin/env bash
# Booru tags of an image, from the wd-tagger Space (https://huggingface.co/spaces/SmilingWolf/wd-tagger): the picture is uploaded to it.
#   tools/wd-tag.sh                       interactive: Enter tags the image in the clipboard, a pasted or dropped file path tags that file, q quits
#   tools/wd-tag.sh [-v] [-n] image.png   once: the tags, comma separated, on stdout and copied to the clipboard (-n: not copied);
#                                         -v also gives the rating and each tag's confidence (those are not copied)
#   ... | tools/wd-tag.sh -               the image comes from stdin
# An image in the clipboard is read with wl-paste, xclip or pngpaste; the tags are copied back with wl-copy, xclip, xsel, pbcopy or clip.exe,
# the first one found that works (WD_COPY=0 is the same as -n). A terminal cannot paste an image, only text: hence Enter, and file paths.
# WD_MODEL      default SmilingWolf/wd-eva02-large-tagger-v3 (the most accurate; also wd-swinv2-tagger-v3, wd-vit-tagger-v3, ...)
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
for tool in curl jq; do command -v "$tool" >/dev/null || { echo "$tool is needed" >&2; exit 2; }; done

url="${WD_URL:-https://smilingwolf-wd-tagger.hf.space}"
model="${WD_MODEL:-SmilingWolf/wd-eva02-large-tagger-v3}"
auth=()
[ -n "${HF_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $HF_TOKEN")
tmp_files=()
trap 'rm -f ${tmp_files[@]+"${tmp_files[@]}"}' EXIT
tags=""
interactive=0

# One try: upload, call, read the answer (server-sent events: "event: complete" and its "data: [...]" line, or "event: error").
call() {
  local file=$1 name=${2:-} uploaded body event
  uploaded=$(curl -sS --fail --max-time 120 "${auth[@]}" -F "files=@\"$file\"${name:+;filename=$name}" "$url/gradio_api/upload") || return 1
  body=$(jq -nc --arg path "$(jq -r '.[0]' <<<"$uploaded")" --arg model "$model" --argjson general "${WD_GENERAL:-0.35}" --argjson character "${WD_CHARACTER:-0.85}" \
    '{data: [{path: $path, meta: {_type: "gradio.FileData"}}, $model, $general, false, $character, false]}')
  event=$(curl -sS --fail --max-time 60 "${auth[@]}" -H 'content-type: application/json' -d "$body" "$url/gradio_api/call/predict" | jq -r '.event_id') || return 1
  curl -sS --fail --max-time 180 "${auth[@]}" "$url/gradio_api/call/predict/$event" | awk '/^event: /{kind=$2} /^data: /{if (kind=="complete") {print substr($0, 7); exit} else if (kind=="error") {print "error " substr($0, 7) > "/dev/stderr"; exit 3}}'
}

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

# The Space can be asleep or busy for a moment: three tries; an error the Space answers with (an unknown model, say) is not asked again.
tag_image() {
  local file=$1 name=${2:-} result="" status attempt
  [ "$interactive" = 0 ] || echo "tagging (the Space takes 10 to 40 seconds)..." >&2
  for attempt in 1 2 3; do
    status=0
    result=$(call "$file" "$name") || status=$?
    [ -n "$result" ] && break
    [ "$status" = 3 ] && return 3
    [ "$attempt" -lt 3 ] && sleep $((attempt * 3))
  done
  [ -n "$result" ] || { echo "wd-tagger gave no answer (is $url up?)" >&2; return 1; }
  tags=$(jq -r '.[0]' <<<"$result")
  printf '%s\n' "$tags"
  [ "$copy" = 0 ] || copy_to_clipboard
  if [ "$verbose" = 1 ]; then
    jq -r '"rating: " + .[1].label' <<<"$result"
    jq -r '.[3].confidences[] | "\(.label) \(.confidence * 100 | round / 100)"' <<<"$result"
  fi
}

# The image in the clipboard goes to a temp file: clip_file and clip_type are set. The list of types is read first, then the image: no pipe
# from the clipboard tool, which would fail with pipefail when the reader stops early.
clip_file=""
clip_type=""
clipboard_image() {
  local types
  clip_file=$(mktemp "${TMPDIR:-/tmp}/wd-tag.XXXXXX")
  tmp_files+=("$clip_file")
  clip_type=""
  if command -v wl-paste >/dev/null 2>&1; then
    types=$(wl-paste --list-types 2>/dev/null || true)
    clip_type=$(grep -m1 '^image/' <<<"$types" || true)
    [ -z "$clip_type" ] || wl-paste --type "$clip_type" >"$clip_file" 2>/dev/null || true
  fi
  if [ ! -s "$clip_file" ] && command -v xclip >/dev/null 2>&1; then
    types=$(xclip -selection clipboard -t TARGETS -o 2>/dev/null || true)
    clip_type=$(grep -m1 '^image/' <<<"$types" || true)
    [ -z "$clip_type" ] || xclip -selection clipboard -t "$clip_type" -o >"$clip_file" 2>/dev/null || true
  fi
  if [ ! -s "$clip_file" ] && command -v pngpaste >/dev/null 2>&1; then
    pngpaste "$clip_file" 2>/dev/null && clip_type=image/png || true
  fi
  [ -s "$clip_file" ]
}

# The text in the clipboard, for a copied file path.
clipboard_text() {
  if command -v wl-paste >/dev/null 2>&1; then wl-paste --no-newline 2>/dev/null && return 0; fi
  if command -v xclip >/dev/null 2>&1; then xclip -selection clipboard -o 2>/dev/null && return 0; fi
  if command -v pbpaste >/dev/null 2>&1; then pbpaste 2>/dev/null && return 0; fi
  return 0
}

# What a terminal pastes for a dropped file: the path, 'quoted', with \ before the spaces, or a file:// URL.
clean_path() {
  local p=$1 from_url=0
  p="${p#"${p%%[![:space:]]*}"}"
  p="${p%"${p##*[![:space:]]}"}"
  case "$p" in \'*\' | \"*\") p=${p:1:${#p}-2} ;; esac
  case "$p" in file://*) p=${p#file://} from_url=1 ;; esac
  p=${p//\\ / }
  [ "$from_url" = 0 ] || p=$(printf '%b' "${p//%/\\x}")
  case "$p" in "~/"*) p="$HOME/${p:2}" ;; esac
  printf '%s' "$p"
}

# Ctrl+V is not the terminal's paste key in most terminals (that is Ctrl+Shift+V, and it pastes text only): the program gets the key itself, which
# readline would use for "insert the next key as it is". It is made to type a word and press Enter, so the loop below sees it as a line.
clip_word="@clipboard"
setup_ctrl_v() {
  local rc
  rc=$(mktemp "${TMPDIR:-/tmp}/wd-tag.XXXXXX")
  tmp_files+=("$rc")
  {
    [ -r /etc/inputrc ] && echo '$include /etc/inputrc'
    [ -r "${INPUTRC:-$HOME/.inputrc}" ] && echo "\$include ${INPUTRC:-$HOME/.inputrc}"
    printf '"\\C-v": "\\C-a\\C-k%s\\C-m"\n' "$clip_word"
  } >"$rc"
  export INPUTRC=$rc
}

interactive_loop() {
  local input file name
  interactive=1
  setup_ctrl_v
  echo "wd-tag ($model): Ctrl+V or Enter = the image in the clipboard (or a copied file path); or paste / drop a file path; q = quit" >&2
  while IFS= read -r -e -p "> " input; do
    case "$input" in q | quit | exit) return 0 ;; esac
    if [ -z "$input" ] || [ "$input" = "$clip_word" ]; then
      if clipboard_image; then
        file=$clip_file
        name="clipboard.${clip_type#image/}"
      else
        file=$(clean_path "$(clipboard_text)")
        name=""
        [ -f "$file" ] || { echo "no image in the clipboard, and its text is not a file (copy an image, or drop a file path)" >&2; continue; }
      fi
    else
      file=$(clean_path "$input")
      name=""
      [ -f "$file" ] || { echo "not a file: $file" >&2; continue; }
    fi
    tag_image "$file" "$name" || true
  done
}

if [ $# -eq 0 ]; then
  [ -t 0 ] || { echo "usage: tools/wd-tag.sh [-v] [-n] [image.png | -]   (no argument at a terminal: interactive)" >&2; exit 2; }
  interactive_loop
elif [ "$1" = "-" ]; then
  stdin_file=$(mktemp "${TMPDIR:-/tmp}/wd-tag.XXXXXX")
  tmp_files+=("$stdin_file")
  cat >"$stdin_file"
  [ -s "$stdin_file" ] || { echo "nothing on stdin" >&2; exit 2; }
  tag_image "$stdin_file" stdin.png || exit $?
else
  [ -f "$1" ] || { echo "no such file: $1" >&2; exit 2; }
  tag_image "$1" || exit $?
fi
