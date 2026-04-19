#!/usr/bin/env bash
# End-to-end smoke test of every public endpoint.
# Requires the stack to be running (bash scripts/start.sh).

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source .env

BASE="http://${ORCH_HOST}:${ORCH_PORT}"
OUT="$ROOT/logs/smoke"
mkdir -p "$OUT"

have() { command -v "$1" >/dev/null 2>&1; }

ok() { printf '  \e[32mPASS\e[0m %s\n' "$1"; }
fail() { printf '  \e[31mFAIL\e[0m %s: %s\n' "$1" "$2"; exit 1; }

echo "Smoke test → $BASE"

# 1. /health
body="$(curl -sf "$BASE/health" || true)"
case "$body" in
  *healthy*|*degraded*) ok "/health" ;;
  *) fail "/health" "$body" ;;
esac

# 2. /info
curl -sf "$BASE/info" > /dev/null && ok "/info" || fail "/info" ""

# 3. /v1/tts/languages
curl -sf "$BASE/v1/tts/languages" > /dev/null && ok "/v1/tts/languages" || fail "/v1/tts/languages" ""

# 4. /v1/tts/tasks
curl -sf "$BASE/v1/tts/tasks" > /dev/null && ok "/v1/tts/tasks" || fail "/v1/tts/tasks" ""

# 5. /v1/audio/voices
curl -sf "$BASE/v1/audio/voices" > /dev/null && ok "GET /v1/audio/voices" || fail "GET /v1/audio/voices" ""

# 5b. /v1/admin/models — list
models_json="$(curl -sf "$BASE/v1/admin/models" || true)"
echo "$models_json" | grep -q '"aggregate_status"' && ok "GET /v1/admin/models" \
  || fail "GET /v1/admin/models" "$models_json"

# 6. CustomVoice (non-streaming WAV)
curl -sf -X POST "$BASE/v1/audio/speech" \
  -H "Content-Type: application/json" \
  -d '{"task_type":"CustomVoice","voice":"vivian","language":"English","input":"Smoke test preset voice."}' \
  -o "$OUT/customvoice.wav"
[[ -s "$OUT/customvoice.wav" ]] && ok "POST /v1/audio/speech (CustomVoice)" \
  || fail "CustomVoice" "no wav written"

# 7. VoiceDesign
curl -sf -X POST "$BASE/v1/audio/speech" \
  -H "Content-Type: application/json" \
  -d '{"task_type":"VoiceDesign","language":"English","instructions":"a warm narrator","input":"Smoke test voice design."}' \
  -o "$OUT/voicedesign.wav"
[[ -s "$OUT/voicedesign.wav" ]] && ok "POST /v1/audio/speech (VoiceDesign)" \
  || fail "VoiceDesign" "no wav written"

# 8. CustomVoice streaming PCM
curl -sf -X POST "$BASE/v1/audio/speech" \
  -H "Content-Type: application/json" \
  -d '{"task_type":"CustomVoice","voice":"ryan","input":"Smoke streaming.","stream":true,"response_format":"pcm"}' \
  --no-buffer -o "$OUT/stream.pcm"
[[ -s "$OUT/stream.pcm" ]] && ok "POST /v1/audio/speech (PCM streaming)" \
  || fail "streaming PCM" "no bytes"

# 9. Voice upload + clone round-trip (uses the customvoice WAV from step 6 as a pretend sample)
NAME="smoketest_$(date +%s)"
curl -sf -X POST "$BASE/v1/audio/voices" \
  -F "audio_sample=@$OUT/customvoice.wav" \
  -F "consent=smoke-$(date +%s)" \
  -F "name=$NAME" \
  -F "ref_text=Smoke test preset voice." \
  > "$OUT/upload_resp.json"
grep -q '"success":true' "$OUT/upload_resp.json" \
  && ok "POST /v1/audio/voices" || fail "voice upload" "$(cat "$OUT/upload_resp.json")"

curl -sf -X POST "$BASE/v1/audio/speech" \
  -H "Content-Type: application/json" \
  -d "{\"task_type\":\"Base\",\"input\":\"Smoke cloned voice.\",\"ref_voice\":\"$NAME\"}" \
  -o "$OUT/base.wav"
[[ -s "$OUT/base.wav" ]] && ok "POST /v1/audio/speech (Base via library)" \
  || fail "Base clone" "no wav written"

# 10. Cleanup
curl -sf -X DELETE "$BASE/v1/audio/voices/$NAME" > /dev/null \
  && ok "DELETE /v1/audio/voices/$NAME" || fail "delete voice" ""

echo
echo "All good. WAVs saved to $OUT"
ls -lh "$OUT"
