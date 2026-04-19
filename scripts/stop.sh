#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source .venv/bin/activate

if [[ ! -f "$ROOT/logs/supervisord.pid" ]]; then
  echo "No supervisord.pid — nothing to stop."
  exit 0
fi

supervisorctl -c "$ROOT/configs/supervisord.conf" shutdown || true
# Wait for PID to die
PID="$(cat "$ROOT/logs/supervisord.pid" 2>/dev/null || echo)"
if [[ -n "$PID" ]]; then
  for _ in $(seq 1 30); do
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.5
  done
  kill -0 "$PID" 2>/dev/null && { echo "Force-killing pid $PID"; kill -9 "$PID"; }
fi
rm -f "$ROOT/logs/supervisord.pid"
echo "Stopped."
