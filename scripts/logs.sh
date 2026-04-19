#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/logs"
echo "Tailing: orchestrator + 3 vllm-omni backends. Ctrl-C to stop."
tail -Fn 20 \
  orchestrator.log \
  customvoice.log \
  voicedesign.log \
  base.log \
  supervisord.log 2>/dev/null
