#!/usr/bin/env bash
# st.sh        start; running containers are restarted (not recreated), re-running st-init first
# st.sh re     start with the containers recreated (picks up docker-compose.yml changes)
# st.sh logs   follow every service and leyline into $SCRATCH/st/all.log, with times, starting with the last 500 lines of each; run it after `re`
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
: "${SCRATCH:?SCRATCH must be set (compose mounts \$SCRATCH/st/{config,data,plugins,extensions})}"
# Everything lives on the ramdisk: chats too, so download the ones worth keeping (SillyTavern's "Manage chat files").
export ST_DATA_DIR="${ST_DATA_DIR:-$SCRATCH/st/data}"
temp_dirs=("$SCRATCH/st/config" "$SCRATCH/st/plugins" "$SCRATCH/st/extensions")

compose() { docker compose -f "$script_dir/docker-compose.yml" "$@"; }

# Before anything else: no container is touched. The log follows the containers that exist when it starts. Every line carries its time
# (-t), so lines of different services can be put in order. leyline is not part of this compose project, so it is followed on its own.
if [ "${1:-}" = logs ]; then
  mkdir -p "$SCRATCH/st"
  : > "$SCRATCH/st/all.log"
  trap 'trap - INT TERM EXIT; kill 0' INT TERM EXIT
  if docker inspect leyline >/dev/null 2>&1; then
    docker logs -f -t --tail 500 leyline 2>&1 | sed -u 's/^/leyline      | /' >> "$SCRATCH/st/all.log" &
  else
    echo "no container named leyline: its log is not followed" >&2
  fi
  compose logs -f -t --no-color --tail 500 >> "$SCRATCH/st/all.log" 2>&1 &
  wait
  exit
fi

case "${1:-}" in "" | re) ;; *) echo "Usage: st.sh [re|logs]" >&2; exit 2 ;; esac

# Missing bind-mount sources would be created root-owned by the Docker daemon.
mkdir -p "$ST_DATA_DIR" "${temp_dirs[@]}"

case "${1:-}" in
  "") compose up -d
      # st-init is one-shot: run it to completion before SillyTavern restarts, so it reads the new seed.
      docker start -a st-init
      # `docker restart` rather than `compose restart`, whose progress view stayed on "Restarting 0.4s" with the timer stopped although
      # the containers were fine (container_name = service).
      docker restart $(compose config --services | grep -vx 'st-init') ;;
  re) compose up -d --force-recreate ;;
esac
