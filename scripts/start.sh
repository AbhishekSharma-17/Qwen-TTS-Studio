#!/usr/bin/env bash
# Launch all 4 services via supervisord (daemonised).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# Auto-export so envsubst below sees our .env variables.
set -a
# shellcheck disable=SC1091
source .env
set +a
# shellcheck disable=SC1091
source .venv/bin/activate

mkdir -p "$LOGS_DIR" "$DATA_DIR/voices" "$DATA_DIR/generated"

# Render supervisord config from template. We explicitly list which variables
# to substitute so that any literal $foo in supervisord syntax isn't touched.
envsubst '$ROOT_DIR $LOGS_DIR $DATA_DIR
  $ORCH_HOST $ORCH_PORT
  $CUSTOMVOICE_HOST $CUSTOMVOICE_PORT $CUSTOMVOICE_MODEL_PATH
  $VOICEDESIGN_HOST $VOICEDESIGN_PORT $VOICEDESIGN_MODEL_PATH
  $BASE_HOST $BASE_PORT $BASE_MODEL_PATH' \
  < configs/supervisord.conf.tpl > configs/supervisord.conf

# Already running?
if [[ -f "$ROOT/logs/supervisord.pid" ]] && \
   kill -0 "$(cat "$ROOT/logs/supervisord.pid")" 2>/dev/null; then
  echo "supervisord already running (pid $(cat "$ROOT/logs/supervisord.pid"))."
  echo "Use 'bash scripts/restart.sh' to restart, or 'bash scripts/stop.sh' first."
  exit 0
fi

supervisord -c "$ROOT/configs/supervisord.conf"
sleep 1
supervisorctl -c "$ROOT/configs/supervisord.conf" status

echo
echo "Services starting. First-run model loads take 30-90s each."
echo "Tail logs:   bash scripts/logs.sh"
echo "UI:          http://127.0.0.1:${ORCH_PORT}/"
