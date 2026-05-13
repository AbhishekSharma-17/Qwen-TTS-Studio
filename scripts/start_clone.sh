#!/usr/bin/env bash
# Convenience wrapper — start the clone-only TTS service (orchestrator + Base).
# Equivalent to: bash scripts/clone_service.sh start
exec "$(dirname "$0")/clone_service.sh" start "$@"
