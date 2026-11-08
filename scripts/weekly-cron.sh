#!/usr/bin/env bash
set -euo pipefail
umask 077

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
begin_marker='# BEGIN news.emre.xyz weekly preparation'
end_marker='# END news.emre.xyz weekly preparation'
temp_dir="$(mktemp -d)"
trap 'rm -rf -- "$temp_dir"' EXIT

if ! crontab -l > "$temp_dir/existing" 2> "$temp_dir/error"; then
  if [[ "$(cat "$temp_dir/error")" == *'no crontab for'* ]]; then
    : > "$temp_dir/existing"
  else
    cat "$temp_dir/error" >&2
    exit 1
  fi
fi

awk -v begin="$begin_marker" -v end="$end_marker" '
  $0 == begin { in_weekly = 1; next }
  $0 == end { in_weekly = 0; next }
  !in_weekly { print }
' "$temp_dir/existing" > "$temp_dir/updated"

mkdir -p "$project_root/video/out"
printf '\n%s\n' "$begin_marker" >> "$temp_dir/updated"
printf '0 9 * * 6 /usr/bin/make --no-print-directory -C "%s" prepare >> "%s/video/out/cron.log" 2>&1\n' \
  "$project_root" "$project_root" >> "$temp_dir/updated"
printf '%s\n' "$end_marker" >> "$temp_dir/updated"
crontab "$temp_dir/updated"
printf '%s\n' 'Installed Saturday 09:00 preparation in the current user crontab (system time zone).'
