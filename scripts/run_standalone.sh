#!/usr/bin/env bash
# run_standalone.sh — launch ONE Qwen3-TTS backend on its own, no orchestrator.
#
# Use this when you want to embed Qwen3-TTS in another app and don't need the
# UI, voice library, or the other two models. The backend speaks the same
# OpenAI-compatible speech API as the full stack on port 8080 — just point
# your client at the port this script prints and you're done.
#
# Usage:
#   bash scripts/run_standalone.sh <CustomVoice|VoiceDesign|Base> [PORT] [HOST]
#
# Examples:
#   bash scripts/run_standalone.sh CustomVoice           # preset speakers  :8091 on 0.0.0.0
#   bash scripts/run_standalone.sh VoiceDesign 8100      # voice design     :8100
#   bash scripts/run_standalone.sh Base 8200 127.0.0.1   # clone, localhost-only
#
# Ctrl-C for a clean shutdown.

set -euo pipefail

TASK="${1:-}"
PORT="${2:-}"
HOST="${3:-0.0.0.0}"

usage() {
  cat <<'EOF'
Usage: run_standalone.sh <CustomVoice|VoiceDesign|Base> [PORT] [HOST]

Launches a single Qwen3-TTS vLLM-Omni backend — no orchestrator, no UI.
Exposes OpenAI-compatible /v1/audio/speech and /v1/audio/voices on the
chosen port (default per task).

Task types:
  CustomVoice    9 preset speakers with optional style control      (default :8091)
  VoiceDesign    Invent a fresh voice from a natural-language desc  (default :8092)
  Base           Clone from a reference audio clip + transcript     (default :8093)

Arguments:
  PORT      TCP port to bind (default depends on task type)
  HOST      Bind address (default 0.0.0.0 — all interfaces)

Client example (after server reports "Uvicorn running on..."):
  curl -sX POST http://127.0.0.1:<PORT>/v1/audio/speech \
    -H 'Content-Type: application/json' \
    -d '{"task_type":"CustomVoice","voice":"ryan","input":"Hello."}' \
    --output out.wav
EOF
}

case "$TASK" in
  ""|-h|--help)
    usage; exit 0 ;;
  CustomVoice) MODEL_SUBDIR="Qwen3-TTS-12Hz-1.7B-CustomVoice"; DEFAULT_PORT=8091 ;;
  VoiceDesign) MODEL_SUBDIR="Qwen3-TTS-12Hz-1.7B-VoiceDesign"; DEFAULT_PORT=8092 ;;
  Base)        MODEL_SUBDIR="Qwen3-TTS-12Hz-1.7B-Base";        DEFAULT_PORT=8093 ;;
  *)
    echo "ERROR: unknown task '$TASK'" >&2
    echo >&2
    usage >&2
    exit 1 ;;
esac

PORT="${PORT:-$DEFAULT_PORT}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Pull common paths from .env if present
if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi

MODEL_DIR="${MODELS_DIR:-$ROOT/models}/$MODEL_SUBDIR"
DEPLOY_CFG="$ROOT/configs/qwen3_tts_dgx.yaml"
VENV_BIN="$ROOT/.venv/bin"

# ---- sanity checks ----
if [[ ! -x "$VENV_BIN/vllm-omni" ]]; then
  echo "ERROR: venv missing or incomplete — run bash scripts/00_install.sh first." >&2
  exit 2
fi
if [[ ! -f "$MODEL_DIR/config.json" ]]; then
  echo "ERROR: model weights missing at $MODEL_DIR" >&2
  echo "       Run bash scripts/10_download_weights.sh to fetch them." >&2
  exit 3
fi
if [[ ! -f "$DEPLOY_CFG" ]]; then
  echo "ERROR: deploy config not found at $DEPLOY_CFG" >&2
  exit 4
fi

# Port-in-use guard (supervisord might already own the default port)
if command -v ss >/dev/null && ss -lnt 2>/dev/null | awk '{print $4}' | grep -Eq ":$PORT\$"; then
  echo "ERROR: port $PORT is already in use." >&2
  echo "       If the full stack is running, stop it first: bash scripts/stop.sh" >&2
  echo "       Or pick a free port: bash scripts/run_standalone.sh $TASK <other-port>" >&2
  exit 5
fi

# ---- graceful shutdown on SIGINT/SIGTERM ----
SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo
    echo "→ Shutting down standalone $TASK server (pid $SERVER_PID)…"
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 30); do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -0 "$SERVER_PID" 2>/dev/null && kill -9 "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup INT TERM EXIT

# shellcheck disable=SC1091
source "$VENV_BIN/../bin/activate"

# ---- banner ----
cat <<BANNER

───────────────────────────────────────────────────────────────────
  Qwen3-TTS · standalone mode · $TASK
───────────────────────────────────────────────────────────────────
  Model          $MODEL_SUBDIR  (~4.3 GB bf16)
  Endpoint       http://$HOST:$PORT/v1/audio/speech
  Voices API     http://$HOST:$PORT/v1/audio/voices
  Deploy config  $DEPLOY_CFG
  Host binding   $HOST    (use 127.0.0.1 for localhost-only)
───────────────────────────────────────────────────────────────────
  First start takes 30–90 s (weight load + CUDA graph compile).
  Wait for: "Uvicorn running on http://$HOST:$PORT"
  Then, e.g.:

    curl -sX POST http://127.0.0.1:$PORT/v1/audio/speech \\
      -H 'Content-Type: application/json' \\
      -d '{
        "task_type":"$TASK",
        "input":"Hello from standalone mode.",
        $( [[ "$TASK" == "CustomVoice" ]] && echo '"voice":"ryan",' )
        $( [[ "$TASK" == "VoiceDesign" ]] && echo '"instructions":"warm narrator voice",' )
        $( [[ "$TASK" == "Base"        ]] && echo '"ref_audio":"data:audio/wav;base64,<base64>","ref_text":"transcript",' )
        "language":"English"
      }' --output out.wav

  Ctrl-C for clean shutdown.

BANNER

# ---- exec the server (replaces this shell) ----
exec vllm-omni serve "$MODEL_DIR" \
  --omni \
  --host "$HOST" \
  --port "$PORT" \
  --trust-remote-code \
  --deploy-config "$DEPLOY_CFG"
