#!/usr/bin/env bash
# Convenience wrapper — launch only the Base (voice clone) backend.
# See scripts/run_standalone.sh for full option docs.
exec "$(dirname "$0")/run_standalone.sh" Base "$@"
