#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source .venv/bin/activate 2>/dev/null || true

if [[ -f "$ROOT/logs/supervisord.pid" ]] && \
   kill -0 "$(cat "$ROOT/logs/supervisord.pid")" 2>/dev/null; then
  supervisorctl -c "$ROOT/configs/supervisord.conf" status
else
  echo "supervisord not running"
  exit 1
fi

echo
# shellcheck disable=SC1091
source .env
echo "Orchestrator health:"
curl -sf "http://${ORCH_HOST}:${ORCH_PORT}/health" | python3 -m json.tool 2>/dev/null \
  || echo "  (orchestrator not reachable)"
