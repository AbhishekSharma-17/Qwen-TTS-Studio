#!/usr/bin/env bash
# Rough single-user latency benchmark.
# Runs N sequential requests per task and prints wall-time stats.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source .env

BASE="http://${ORCH_HOST}:${ORCH_PORT}"
N="${1:-5}"
OUT="$ROOT/logs/bench"
mkdir -p "$OUT"

run() {
  local name="$1"; shift
  local body="$1"; shift
  local out="$OUT/$name"
  mkdir -p "$out"
  local total=0 n=0
  for i in $(seq 1 "$N"); do
    local t0 t1 dt
    t0=$(date +%s%3N)
    curl -sf -X POST "$BASE/v1/audio/speech" \
      -H "Content-Type: application/json" \
      -d "$body" \
      -o "$out/run_$i.wav"
    t1=$(date +%s%3N)
    dt=$((t1 - t0))
    total=$((total + dt))
    n=$((n + 1))
    printf '  %s run %d : %d ms\n' "$name" "$i" "$dt"
  done
  if (( n > 0 )); then
    local avg=$((total / n))
    printf '  %s AVG : %d ms over %d runs\n\n' "$name" "$avg" "$n"
  fi
}

run "customvoice" \
  '{"task_type":"CustomVoice","voice":"ryan","language":"English","input":"This is a benchmark run, checking how quickly the preset voice responds."}'

run "voicedesign" \
  '{"task_type":"VoiceDesign","language":"English","instructions":"a warm narrator voice","input":"This is a benchmark run, checking how quickly voice design responds."}'

echo "Done. WAVs under $OUT"
