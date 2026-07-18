#!/usr/bin/env bash
set -euo pipefail

umask 077

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repo_root="${RIFUGIO_ROOT:-$(CDPATH= cd -- "$script_dir/../../.." && pwd)}"
relay_file="${RIFUGIO_TERMINAL_RELAY_FILE:-$repo_root/data/relay/relay.txt}"
relay_dir="$(dirname "$relay_file")"
history_dir="${RIFUGIO_TERMINAL_RELAY_HISTORY_DIR:-$relay_dir/relay_history}"
safe_id="$(printf '%s' "${1:-default}" | tr -cd '[:alnum:]_-' | cut -c1-48)"
safe_id="${safe_id:-default}"

mkdir -p "$relay_dir" "$history_dir"
tmp_file="$(mktemp "$relay_dir/.relay.txt.tmp.XXXXXX")"
cleanup() {
  rm -f "$tmp_file"
}
trap cleanup EXIT

cat > "$tmp_file"
if [[ ! -s "$tmp_file" ]]; then
  printf 'relay content is empty; refusing to replace %s\n' "$relay_file" >&2
  exit 2
fi

exec 9>"$relay_dir/.relay.lock"
flock 9

if [[ -s "$relay_file" ]] && cmp -s "$relay_file" "$tmp_file"; then
  printf 'relay content is unchanged; refusing a false handoff\n' >&2
  exit 3
fi

if [[ -s "$relay_file" ]]; then
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  serial="$(date +%s%N)"
  archive_file="$history_dir/relay.$stamp.$serial.$safe_id.txt"
  cp --preserve=mode,timestamps "$relay_file" "$archive_file"
  chmod 600 "$archive_file"
fi

chmod 600 "$tmp_file"
mv -f "$tmp_file" "$relay_file"
trap - EXIT

printf '%s\n' "$relay_file"
