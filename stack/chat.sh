#!/usr/bin/env bash
# chat.sh [backup] <out-dir> [ssh-host]     copy every SillyTavern chat file, byte for byte, from the server into out-dir, keeping the layout
#                                           <user>/chats/<character>/<chat>.jsonl and the modification times (`ls -t` shows the newest first)
# chat.sh upload <chat.jsonl> [ssh-host] [character]
#                                           put a (cleaned) chat on the server as a new chat of the character; it shows up in SillyTavern's
#                                           chat list; the character's chat folder is made if it is missing. An existing chat is never overwritten.
#                                           The character is the folder name under chats/: the third argument, else found from the file.
# backup is the default: `chat.sh <out-dir>` works. The chats are the user's story: keep out-dir and the files outside this repository.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
usage() { sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }

case "${1:-}" in
  backup) shift ;;
  upload) cmd=upload; shift ;;
  "" | -h | --help) usage ;;
esac
cmd="${cmd:-backup}"

# data/ is root-owned on the server; decide up front whether sudo is needed, so a half-read stream never gets a second one appended.
backup() {
  local out="${1:?usage: chat.sh [backup] <out-dir> [ssh-host]}" host="${2:-mc}" out_abs n
  # An unset variable in the first position makes the host name the out-dir, and a chat inside this repository is one `git add .` from
  # being committed: refuse, before anything is created.
  out_abs="$(realpath -m -- "$out")"
  case "$out_abs/" in
    "$script_dir"/*) echo "refusing: $out_abs is inside the repository ($script_dir); give a directory outside it" >&2; exit 1 ;;
  esac
  mkdir -p "$out"
  ssh "$host" bash -s <<'EOF' | tar -C "$out" -xf -
set -euo pipefail
root="$HOME/others/tavern-stack/data/data"
if ls "$root"/*/chats >/dev/null 2>&1; then as=env; else as="sudo -n"; fi
$as sh -c 'cd "$0" && find . -type f -path "*/chats/*/*.jsonl" -print0 | tar -cf - --null -T -' "$root"
EOF
  n="$(find "$out" -type f -path '*/chats/*/*.jsonl' | wc -l)"
  [ "$n" -gt 0 ] || { echo "no chat file was copied" >&2; exit 1; }
  echo "$n chat file(s) are in $out, newest first:"
  find "$out" -type f -path '*/chats/*/*.jsonl' -printf '%TY-%Tm-%Td %TH:%TM  %p\n' | sort -r | head -5 | sed 's/^/  /'
}

# The folder under chats/ that holds a chat with this integrity id (SillyTavern gives every chat one, and a cleaned copy keeps it). When no
# folder has it (the original is gone, e.g. after a reset), the only folder under chats/ if there is exactly one. Printed only when that
# leaves exactly one; several folders are never guessed between.
find_character() {
  ssh "$1" bash -s -- "$2" <<'EOF'
set -euo pipefail
root="$HOME/others/tavern-stack/data/data/default-user/chats"
if ls "$root" >/dev/null 2>&1; then as=env; else as="sudo -n"; fi
found="$($as sh -c 'cd "$0" && grep -rlF --include="*.jsonl" -- "$1" . | sed "s#^\./##; s#/.*##" | sort -u' "$root" "$1" || true)"
if [ -z "$found" ]; then
  found="$($as find "$root" -mindepth 1 -maxdepth 1 -type d -printf '%f\n')"
  [ "$(printf '%s\n' "$found" | grep -c .)" -ne 1 ] || echo "no chat of the server has this chat's id: using the only character folder, $found" >&2
fi
[ "$(printf '%s\n' "$found" | grep -c .)" -eq 1 ] && printf '%s\n' "$found" || true
EOF
}

# The character: the third argument, else the folder the file sits in (.../chats/<character>/, as backup writes it), else the
# character_name in the file when it is a name (SillyTavern itself writes "unused"), else the folder of the chat that has the same
# integrity id on the server. The file name is the chat's name.
upload() {
  local file="${1:?usage: chat.sh upload <chat.jsonl> [ssh-host] [character]}" host="${2:-mc}" char="${3:-}" file_abs name script size sent integrity
  [ -f "$file" ] || { echo "no such file: $file" >&2; exit 1; }
  file_abs="$(realpath -- "$file")"
  case "$file_abs" in
    "$script_dir"/*) echo "refusing: $file_abs is inside the repository ($script_dir)" >&2; exit 1 ;;
  esac
  if [ -z "$char" ]; then
    case "$file_abs" in */chats/*/*) char="$(basename -- "$(dirname -- "$file_abs")")" ;; esac
  fi
  if [ -z "$char" ]; then
    char="$(python3 -I -c 'import json,sys; print(json.loads(sys.stdin.readline()).get("character_name", ""))' < "$file")"
    [ "$char" != unused ] || char=""
  fi
  if [ -z "$char" ]; then
    integrity="$(python3 -I -c 'import json,sys; print(json.loads(sys.stdin.readline()).get("chat_metadata", {}).get("integrity", ""))' < "$file")"
    [ -z "$integrity" ] || char="$(find_character "$host" "$integrity")"
  fi
  [ -n "$char" ] || { echo "cannot tell the character of $file (no chats/<character>/ folder, no character_name, and not exactly one folder on the server holds a chat of it): give it as the third argument" >&2; exit 1; }
  name="$(basename -- "$file")"
  script='set -euo pipefail
char=$1; name=$2
root="$HOME/others/tavern-stack/data/data/default-user"
dir="$root/chats/$char"
[ -d "$root" ] || { echo "SillyTavern has no data on the server yet ($root): start it once first" >&2; exit 1; }
# A fresh SillyTavern has no chat folder for a character until its first chat is saved; make the missing levels, owned by the container user.
for d in "$root/chats" "$dir"; do
  [ -d "$d" ] || mkdir "$d" 2>/dev/null || { sudo -n mkdir "$d" && sudo -n chown 1000:1000 "$d"; }
done
[ -e "$root/characters/$char.png" ] || echo "note: no card named $char on the server yet; import it, or the chat is not listed" >&2
[ ! -e "$dir/$name" ] || { echo "$name already exists on the server" >&2; exit 1; }
if [ -w "$dir" ]; then cat > "$dir/$name"; else sudo -n tee "$dir/$name" >/dev/null && sudo -n chown 1000:1000 "$dir/$name"; fi
wc -c < "$dir/$name" 2>/dev/null || sudo -n sh -c "wc -c < \"\$0\"" "$dir/$name"'
  # The script travels as base64 so that no quoting survives between here and the remote shell; stdin stays free for the file.
  script="$(printf '%s' "$script" | base64 -w0)"
  sent="$(wc -c < "$file")"
  size="$(ssh "$host" "bash -c \"\$(echo $script | base64 -d)\" _ $(printf %q "$char") $(printf %q "$name")" < "$file")"
  [ "$size" = "$sent" ] || { echo "the server has $size bytes, sent $sent: check $name on the server" >&2; exit 1; }
  echo "uploaded $name ($sent bytes) as a chat of $char; open the character in SillyTavern and pick it in the chat list"
}

"$cmd" "$@"
