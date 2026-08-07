#!/usr/bin/env bash
set -euo pipefail

probe_root=$1
owner_id=$2
session_id=$3
turn_id=$4
expected_exit=$5
output_root="$probe_root/output/$turn_id"
control_root="$probe_root/control"
mkdir -p "$output_root" "$control_root"

emit_stdout() {
  printf '%s\n' "$1" | tee -a "$output_root/stdout.raw"
}

emit_stderr() {
  printf '%s\n' "$1" | tee -a "$output_root/stderr.raw" >&2
}

emit_lifecycle() {
  printf '{"event":"%s","ownerId":"%s","sessionId":"%s","turnId":"%s"}\n' \
    "$1" "$owner_id" "$session_id" "$turn_id" >> "$output_root/lifecycle.jsonl"
}

wait_for_control() {
  local path="$control_root/$turn_id.$1"
  local attempts=0
  while [[ ! -f "$path" ]]; do
    attempts=$((attempts + 1))
    if [[ $attempts -ge 200 ]]; then
      emit_lifecycle "timed-out"
      emit_stderr "$owner_id timed out waiting for $1"
      exit 124
    fi
    sleep 0.05
  done
}

emit_lifecycle "started"
printf '%s\033[31m%s\033[0m %s\n' "$owner_id " "colored" \
  "step=1 root=$probe_root token=${owner_id}-secret" | tee -a "$output_root/stdout.raw"
touch "$control_root/$turn_id.ready"

wait_for_control "step-2"
emit_stdout "$owner_id step=2 ${owner_id}:$(printf 'x%.0s' {1..1400})"
emit_lifecycle "updated"
touch "$control_root/$turn_id.updated"

wait_for_control "finish"
emit_stderr "$owner_id stderr complete password=${owner_id}-password"
if [[ $expected_exit -eq 0 ]]; then
  emit_lifecycle "completed"
else
  emit_lifecycle "failed"
fi
exit "$expected_exit"