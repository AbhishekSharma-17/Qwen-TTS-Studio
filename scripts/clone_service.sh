#!/usr/bin/env bash
# clone_service.sh — minimal clone-only TTS service.
#
# Runs only what's needed to use saved cloned voices ("Abhishek", "Hari", …):
#   • Base vLLM-Omni backend  on  $CLONE_BASE_PORT  (default 8022, internal)
#   • FastAPI orchestrator    on  $CLONE_ORCH_PORT  (default 8020, public-bind)
#
# CustomVoice and VoiceDesign are NOT started — saves ~8.6 GB of GPU.
# Coexists peacefully with the full stack on its own ports.
#
# Usage:
#   bash scripts/clone_service.sh start
#   bash scripts/clone_service.sh stop
#   bash scripts/clone_service.sh restart
#   bash scripts/clone_service.sh status
#   bash scripts/clone_service.sh logs
#
# Env overrides (defaults shown):
#   CLONE_ORCH_HOST=0.0.0.0     # 127.0.0.1 to lock to localhost
#   CLONE_ORCH_PORT=8020
#   CLONE_BASE_HOST=127.0.0.1
#   CLONE_BASE_PORT=8022

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

: "${CLONE_ORCH_HOST:=0.0.0.0}"
: "${CLONE_ORCH_PORT:=8020}"
: "${CLONE_BASE_HOST:=127.0.0.1}"
: "${CLONE_BASE_PORT:=8022}"

# Load project .env for MODELS_DIR / DATA_DIR / LOGS_DIR if present.
if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi
: "${MODELS_DIR:=$ROOT/models}"
: "${DATA_DIR:=$ROOT/data}"
: "${LOGS_DIR:=$ROOT/logs}"

VENV_BIN="$ROOT/.venv/bin"
DEPLOY_CFG="$ROOT/configs/qwen3_tts_dgx.yaml"
BASE_MODEL_DIR="$MODELS_DIR/Qwen3-TTS-12Hz-1.7B-Base"

PID_BASE="$LOGS_DIR/clone_base.pid"
PID_ORCH="$LOGS_DIR/clone_orchestrator.pid"
LOG_BASE="$LOGS_DIR/clone_base.log"
LOG_ORCH="$LOGS_DIR/clone_orchestrator.log"

mkdir -p "$LOGS_DIR" "$DATA_DIR/voices"

color()  { printf '\033[%sm%s\033[0m' "$1" "$2"; }
green()  { color "32" "$1"; }
yellow() { color "33" "$1"; }
red()    { color "31" "$1"; }
dim()    { color "2"  "$1"; }
bold()   { color "1"  "$1"; }

# Return 0 if a process from `pidfile` is alive and named like the expected pattern.
pid_alive() {
  local pidfile="$1" name="$2"
  [[ -f "$pidfile" ]] || return 1
  local pid; pid=$(cat "$pidfile" 2>/dev/null || true)
  [[ -n "${pid:-}" ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  ps -p "$pid" -o command= 2>/dev/null | grep -q "$name" || return 1
  return 0
}

# Returns 0 if a TCP port is listening.
port_listening() {
  local port="$1"
  ss -lnt 2>/dev/null | awk '{print $4}' | grep -Eq ":$port\$"
}

pre_flight() {
  if [[ ! -x "$VENV_BIN/vllm-omni" ]]; then
    red "ERROR: venv missing — run bash scripts/00_install.sh first."; echo
    exit 2
  fi
  if [[ ! -f "$BASE_MODEL_DIR/config.json" ]]; then
    red "ERROR: Base model weights missing at $BASE_MODEL_DIR"; echo
    yellow "       Run: bash scripts/10_download_weights.sh"; echo
    exit 3
  fi
  if [[ ! -f "$DEPLOY_CFG" ]]; then
    red "ERROR: deploy config not found at $DEPLOY_CFG"; echo
    exit 4
  fi
}

start_base() {
  if pid_alive "$PID_BASE" "vllm-omni"; then
    yellow "→ Base backend already running (pid $(cat "$PID_BASE")) on :$CLONE_BASE_PORT"
    echo; return 0
  fi
  if port_listening "$CLONE_BASE_PORT"; then
    red "ERROR: port $CLONE_BASE_PORT is already in use by another process."; echo
    exit 5
  fi

  green "→ Starting Base backend on $CLONE_BASE_HOST:$CLONE_BASE_PORT (logs: $LOG_BASE)"; echo

  : > "$LOG_BASE"
  # Launch detached so the shell can return
  nohup "$VENV_BIN/vllm-omni" serve "$BASE_MODEL_DIR" \
    --omni \
    --host "$CLONE_BASE_HOST" \
    --port "$CLONE_BASE_PORT" \
    --trust-remote-code \
    --served-model-name "Qwen/Qwen3-TTS-12Hz-1.7B-Base" \
    --deploy-config "$DEPLOY_CFG" \
    >> "$LOG_BASE" 2>&1 &
  echo $! > "$PID_BASE"
  disown 2>/dev/null || true

  dim "  pid $(cat "$PID_BASE")  · waiting for Uvicorn (cold start ~30-90 s)…"; echo
  for _ in $(seq 1 60); do
    if curl -s -m 2 "http://$CLONE_BASE_HOST:$CLONE_BASE_PORT/v1/audio/voices" -o /dev/null; then
      green "  Base backend up."; echo
      return 0
    fi
    if ! kill -0 "$(cat "$PID_BASE")" 2>/dev/null; then
      red "  Base backend died during boot — see $LOG_BASE"; echo
      exit 6
    fi
    sleep 3
  done
  red "  Base backend did not respond within 180 s — see $LOG_BASE"; echo
  exit 7
}

start_orchestrator() {
  if pid_alive "$PID_ORCH" "orchestrator"; then
    yellow "→ Orchestrator already running (pid $(cat "$PID_ORCH")) on :$CLONE_ORCH_PORT"
    echo; return 0
  fi
  if port_listening "$CLONE_ORCH_PORT"; then
    red "ERROR: port $CLONE_ORCH_PORT is already in use."; echo
    exit 5
  fi

  green "→ Starting orchestrator on $CLONE_ORCH_HOST:$CLONE_ORCH_PORT (logs: $LOG_ORCH)"; echo
  : > "$LOG_ORCH"

  # We point the orchestrator at our private Base backend.
  # CustomVoice / VoiceDesign URLs are filled in but won't resolve — the
  # backend registry will mark them "down" and the task-gate UI will reflect
  # that. For pure Base/clone use, that's harmless.
  PYTHONPATH="$ROOT" \
    ORCH_HOST="$CLONE_ORCH_HOST" \
    ORCH_PORT="$CLONE_ORCH_PORT" \
    BASE_HOST="$CLONE_BASE_HOST" \
    BASE_PORT="$CLONE_BASE_PORT" \
    BASE_MODEL_PATH="$BASE_MODEL_DIR" \
    CUSTOMVOICE_HOST="127.0.0.1" CUSTOMVOICE_PORT="65531" \
    CUSTOMVOICE_MODEL_PATH="$MODELS_DIR/Qwen3-TTS-12Hz-1.7B-CustomVoice" \
    VOICEDESIGN_HOST="127.0.0.1" VOICEDESIGN_PORT="65532" \
    VOICEDESIGN_MODEL_PATH="$MODELS_DIR/Qwen3-TTS-12Hz-1.7B-VoiceDesign" \
    MODELS_DIR="$MODELS_DIR" \
    DATA_DIR="$DATA_DIR" \
    LOGS_DIR="$LOGS_DIR" \
    VOICES_JSON="$DATA_DIR/voices.json" \
    VOICES_DIR="$DATA_DIR/voices" \
  nohup "$VENV_BIN/uvicorn" orchestrator.app:app \
    --host "$CLONE_ORCH_HOST" \
    --port "$CLONE_ORCH_PORT" \
    --proxy-headers --no-access-log \
    >> "$LOG_ORCH" 2>&1 &
  echo $! > "$PID_ORCH"
  disown 2>/dev/null || true

  dim "  pid $(cat "$PID_ORCH")  · waiting for /health…"; echo
  for _ in $(seq 1 30); do
    if curl -s -m 2 "http://127.0.0.1:$CLONE_ORCH_PORT/health" -o /dev/null; then
      green "  Orchestrator up."; echo
      return 0
    fi
    if ! kill -0 "$(cat "$PID_ORCH")" 2>/dev/null; then
      red "  Orchestrator died — see $LOG_ORCH"; echo
      exit 6
    fi
    sleep 1
  done
  red "  Orchestrator did not respond within 30 s — see $LOG_ORCH"; echo
  exit 7
}

start() {
  pre_flight
  echo
  bold "============================================================="; echo
  bold "  Qwen TTS Studio — clone-only service (start)";              echo
  bold "============================================================="; echo
  echo "  Models loaded : $(yellow "Base only") (Qwen3-TTS-12Hz-1.7B-Base)"
  echo "  Saved voices  : $(curl -s "http://127.0.0.1:$CLONE_ORCH_PORT/v1/audio/voices" 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin); print(', '.join(v['name'] for v in d.get('uploaded_voices',[])) or '(none yet)')
except: print('(check after start)')
")"
  echo "  Public URL    : $(green "http://$CLONE_ORCH_HOST:$CLONE_ORCH_PORT")"
  echo "  Base (internal) : http://$CLONE_BASE_HOST:$CLONE_BASE_PORT"
  echo

  start_base
  start_orchestrator

  echo
  bold "============================================================="; echo
  green "  READY";                                                       echo
  bold "============================================================="; echo
  echo
  echo "  Endpoints:"
  echo "    POST  http://<host>:$CLONE_ORCH_PORT/v1/audio/speech"
  echo "    GET   http://<host>:$CLONE_ORCH_PORT/v1/audio/voices"
  echo "    GET   http://<host>:$CLONE_ORCH_PORT/health"
  echo
  echo "  Quick test:"
  cat <<EOF
    curl -sX POST http://127.0.0.1:$CLONE_ORCH_PORT/v1/audio/speech \\
      -H 'Content-Type: application/json' \\
      -d '{"task_type":"Base","input":"Hello.","ref_voice":"Abhishek","language":"English"}' \\
      --output /tmp/clone_test.wav && play /tmp/clone_test.wav
EOF
  echo
  echo "  Stop with:  $(yellow "bash scripts/clone_service.sh stop")"
  echo "  Logs with:  $(yellow "bash scripts/clone_service.sh logs")"
  echo
}

stop_one() {
  local name="$1" pidfile="$2"
  if [[ ! -f "$pidfile" ]]; then
    dim "  ($name) not running (no pidfile)"; echo
    return 0
  fi
  local pid; pid=$(cat "$pidfile" 2>/dev/null || true)
  if [[ -z "${pid:-}" ]] || ! kill -0 "$pid" 2>/dev/null; then
    dim "  ($name) not running (stale pidfile, cleaning up)"; echo
    rm -f "$pidfile"
    return 0
  fi
  yellow "→ Stopping $name (pid $pid)…"; echo
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 30); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    red "  $name (pid $pid) didn't exit on SIGTERM — sending SIGKILL"; echo
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
  green "  $name stopped."; echo
}

stop() {
  # Stop orchestrator first so it doesn't keep probing a vanishing backend
  stop_one "orchestrator" "$PID_ORCH"
  stop_one "base backend" "$PID_BASE"
}

status() {
  printf '  %-15s  %-7s  %-7s  %-15s\n' service state pid port
  printf '  %-15s  %-7s  %-7s  %-15s\n' --------------- ------- ------- ---------------

  local s p
  if pid_alive "$PID_ORCH" "orchestrator"; then s="$(green up)";    p="$(cat "$PID_ORCH")"
  else                                          s="$(red  down)";  p="—"
  fi
  printf '  %-15s  %-7s  %-7s  %-15s\n' orchestrator "$s" "$p" "$CLONE_ORCH_PORT"

  if pid_alive "$PID_BASE" "vllm-omni"; then s="$(green up)";    p="$(cat "$PID_BASE")"
  else                                       s="$(red  down)";  p="—"
  fi
  printf '  %-15s  %-7s  %-7s  %-15s\n' base "$s" "$p" "$CLONE_BASE_PORT"

  echo
  if curl -s -m 2 "http://127.0.0.1:$CLONE_ORCH_PORT/health" 2>/dev/null | python3 -m json.tool 2>/dev/null; then
    :
  else
    dim "  (orchestrator not responding to /health)"
    echo
  fi
}

logs() {
  echo "Tailing $LOG_ORCH  +  $LOG_BASE   (Ctrl-C to stop)"
  echo
  tail -Fn 50 "$LOG_ORCH" "$LOG_BASE" 2>/dev/null
}

usage() {
  cat <<EOF
Usage: bash scripts/clone_service.sh <command>

Commands:
  start     Boot Base backend + orchestrator (clone-only minimal stack)
  stop      Stop both
  restart   Stop + start
  status    Show pid / port / health for each
  logs      Tail both log files

Env overrides:
  CLONE_ORCH_HOST=0.0.0.0     bind interface for the orchestrator
  CLONE_ORCH_PORT=8020        public port (call this from your clients)
  CLONE_BASE_HOST=127.0.0.1   internal Base backend bind
  CLONE_BASE_PORT=8022        internal Base backend port
EOF
}

case "${1:-help}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  status)  status ;;
  logs)    logs ;;
  *)       usage ;;
esac
