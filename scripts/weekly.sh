#!/usr/bin/env bash
set -euo pipefail
umask 077

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
action="${1:-}"
requested_week="${2:-}"
out_root="$project_root/video/out"
pending_file="$out_root/pending-week"

if [[ "$action" != prepare && "$action" != approve ]]; then
  printf '%s\n' 'Usage: weekly.sh prepare|approve [YYYY-Www]' >&2
  exit 1
fi

mkdir -p "$out_root"
exec 9>"$out_root/.weekly.lock"
if ! flock -n 9; then
  printf '%s\n' 'Another weekly preparation or approval is already running.' >&2
  exit 1
fi

notify_review() {
  local title="$1"
  local detail="$2"
  local session_bus="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}"

  if command -v notify-send >/dev/null 2>&1; then
    if ! DBUS_SESSION_BUS_ADDRESS="$session_bus" notify-send \
      --app-name='Weekly news' --expire-time=0 "$title" "$detail"; then
      printf '%s\n' 'Desktop notification failed. Check the preparation log and your desktop session.' >&2
    fi
  else
    printf '%s\n' 'notify-send is not installed; review notification could not be delivered.' >&2
  fi
}

on_failure() {
  local exit_status="$?"
  trap - ERR
  notify_review 'Weekly news failed' "The $action step failed. See $out_root/cron.log or the terminal output."
  exit "$exit_status"
}
trap on_failure ERR

pending_week=''
if [[ -f "$pending_file" ]]; then
  IFS= read -r pending_week < "$pending_file"
  if [[ ! "$pending_week" =~ ^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$ ]]; then
    printf '%s\n' 'Invalid pending week. Inspect video/out/pending-week before continuing.' >&2
    exit 1
  fi
fi

if [[ "$action" == prepare && -n "$pending_week" ]]; then
  printf 'Week %s is still awaiting review; its script will not be overwritten.\n' "$pending_week"
  notify_review "Weekly news awaiting review: $pending_week" \
    "Review $out_root/$pending_week/script.md, then run make approve in $project_root."
  exit 0
fi

if [[ "$action" == approve ]]; then
  if [[ -z "$pending_week" ]]; then
    printf '%s\n' 'No prepared week is awaiting approval. Run make prepare first.' >&2
    exit 1
  fi
  if [[ -n "$requested_week" && "$requested_week" != "$pending_week" ]]; then
    printf 'Week %s is pending; refusing to approve a different week.\n' "$pending_week" >&2
    exit 1
  fi
  week="$pending_week"
else
  week="${requested_week:-$(date -u +%G-W%V)}"
fi

if [[ ! "$week" =~ ^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$ ]]; then
  printf '%s\n' 'Invalid week. Expected YYYY-Www.' >&2
  exit 1
fi

if [[ "$action" == prepare ]]; then
  if [[ -f "$out_root/$week/script.md" ]]; then
    printf 'Script already exists for %s; refusing to overwrite it. Use the individual video targets for this edition.\n' "$week" >&2
    exit 1
  fi
  make --no-print-directory -C "$project_root" video-draft WEEK="$week"
  printf '%s\n' "$week" > "$pending_file"
  printf 'Ready for review: %s/%s/script.md\nRun make approve from %s after reviewing.\n' "$out_root" "$week" "$project_root"
  notify_review "Weekly news ready: $week" \
    "Review $out_root/$week/script.md, then run make approve in $project_root."
else
  make --no-print-directory -C "$project_root" video-approve WEEK="$week"
  make --no-print-directory -C "$project_root" video-produce WEEK="$week"
  rm -- "$pending_file"
  notify_review "Weekly news produced: $week" 'Video production and upload completed. Review visibility in YouTube Studio.'
fi
