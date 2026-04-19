#!/usr/bin/env bash
# Materialise model weights in $MODELS_DIR.
#
# If any of Base / CustomVoice / VoiceDesign / Tokenizer are missing locally
# they are downloaded fresh from Hugging Face (~4 GB each; ~13 GB total).
# Safe to re-run — existing weights are detected and skipped.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source .env

mkdir -p "$MODELS_DIR"
# shellcheck disable=SC1091
source "$ROOT/.venv/bin/activate"

REPOS=(
  "Qwen/Qwen3-TTS-Tokenizer-12Hz"
  "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
  "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
  "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
)

for repo in "${REPOS[@]}"; do
  name="${repo##*/}"
  target="$MODELS_DIR/$name"
  if [[ -d "$target" && -f "$target/config.json" ]]; then
    size="$(du -sh "$target" 2>/dev/null | cut -f1)"
    echo "  HAVE  $name ($size) — skipping"
    continue
  fi
  echo "  PULL  $repo -> $target"
  huggingface-cli download "$repo" --local-dir "$target"
done

echo
echo "Models directory:"
du -sh "$MODELS_DIR"/*/
echo
echo "Next: bash scripts/start.sh"
