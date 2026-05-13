#!/usr/bin/env bash
# Convenience wrapper — stop the clone-only TTS service (orchestrator + Base).
#
# This is the dedicated stop command for the clone service.
# Equivalent to: bash scripts/clone_service.sh stop
#
# It's safe to call even when the service is already stopped — stale PID
# files are cleaned up automatically and graceful TERM → KILL is used.
exec "$(dirname "$0")/clone_service.sh" stop "$@"
