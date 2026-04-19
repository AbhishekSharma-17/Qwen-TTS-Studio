#!/usr/bin/env bash
# One-shot installer for Qwen3-TTS Studio on DGX Spark (aarch64, CUDA 13.0).
#
# What this does:
#   1. Creates .venv with Python 3.12 via uv
#   2. Installs vLLM aarch64 wheel for cu130 (pinned)
#   3. Clones vllm-omni, patches out fa3-fwd (no ARM64 build), installs editable
#   4. Builds flash-attn 2 from source (no prebuilt aarch64+cu130 wheels)
#   5. Installs orchestrator Python deps
#
# Runtime: ~30-60 min (flash-attn compile dominates).
# Logs build output to logs/install.log in addition to stdout.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p logs
LOG="$ROOT/logs/install.log"
: > "$LOG"

log() { printf '[install] %s\n' "$*" | tee -a "$LOG"; }
run() { log "\$ $*"; "$@" 2>&1 | tee -a "$LOG"; }

log "ROOT=$ROOT"
log "Platform: $(uname -m) | $(uname -sr)"

# ---------------------------------------------------------------------------
# 1. Python 3.12 venv via uv
# ---------------------------------------------------------------------------
if [[ ! -d "$ROOT/.venv" ]]; then
  log "Creating .venv with Python 3.12"
  uv venv .venv --python 3.12 2>&1 | tee -a "$LOG"
fi
# shellcheck disable=SC1091
source "$ROOT/.venv/bin/activate"
log "Python: $(python --version) | Pip: $(pip --version)"

# ---------------------------------------------------------------------------
# 2. System-level build deps (prompts once for sudo)
# ---------------------------------------------------------------------------
if ! dpkg -s build-essential >/dev/null 2>&1; then
  log "Installing system build deps (requires sudo)"
  sudo apt-get update 2>&1 | tee -a "$LOG"
  sudo apt-get install -y ffmpeg sox python3.12-dev build-essential git ninja-build 2>&1 | tee -a "$LOG"
else
  log "System build deps already present"
fi

# ---------------------------------------------------------------------------
# 3. vLLM 0.19.1 aarch64 + cu130 wheel — matches current vllm-omni main.
#    (v0.16.0 worked with Feb 2026 vllm-omni but that branch has since
#     rebased to vllm 0.19; importing newer vllm-omni against vllm 0.16
#     fails with ImportError on TokensInput.)
# ---------------------------------------------------------------------------
VLLM_VER='0.19.1'
VLLM_WHL="https://github.com/vllm-project/vllm/releases/download/v${VLLM_VER}/vllm-${VLLM_VER}+cu130-cp38-abi3-manylinux_2_35_aarch64.whl"
cur_vllm="$(python -c 'import vllm;print(vllm.__version__)' 2>/dev/null || echo '')"
if [[ "$cur_vllm" != "$VLLM_VER" ]]; then
  log "Installing vLLM ${VLLM_VER} aarch64 wheel (was: ${cur_vllm:-none})"
  uv pip install --upgrade "$VLLM_WHL" \
    --extra-index-url https://download.pytorch.org/whl/cu130 \
    --index-strategy unsafe-best-match 2>&1 | tee -a "$LOG"
else
  log "vLLM ${VLLM_VER} already installed"
fi

# ---------------------------------------------------------------------------
# 4. vllm-omni (clone + patch + editable install)
# ---------------------------------------------------------------------------
if [[ ! -d "$ROOT/vllm-omni" ]]; then
  log "Cloning vllm-omni"
  git clone https://github.com/vllm-project/vllm-omni.git "$ROOT/vllm-omni" 2>&1 | tee -a "$LOG"
fi
cd "$ROOT/vllm-omni"

# fa3-fwd is Hopper-only, won't build on Blackwell/ARM. Drop it.
if grep -q '^fa3-fwd==' requirements/cuda.txt 2>/dev/null; then
  log "Patching vllm-omni requirements/cuda.txt (removing fa3-fwd)"
  sed -i.bak '/^fa3-fwd==/d' requirements/cuda.txt
fi

log "Installing vllm-omni (editable, with demo extras)"
uv pip install -e '.[demo]' 2>&1 | tee -a "$LOG"
cd "$ROOT"

# ---------------------------------------------------------------------------
# 5. flash-attn 2 from source (aarch64+cu130 has no prebuilt wheel).
#    Target ONLY sm_120 (GB10 Blackwell). Building for sm_80/90/100 too
#    would quadruple compile time for kernels we never run.
# ---------------------------------------------------------------------------
if ! python -c 'import flash_attn' 2>/dev/null; then
  log "Building flash-attn 2 from source for sm_120 only (~10-12 min). Logs to $LOG"
  export MAX_JOBS=6
  export NVCC_THREADS=2
  export FLASH_ATTENTION_FORCE_BUILD=TRUE
  export TORCH_CUDA_ARCH_LIST="12.0"
  export FLASH_ATTN_CUDA_ARCHS="120"
  uv pip install --no-cache --no-build-isolation \
    'flash-attn @ git+https://github.com/Dao-AILab/flash-attention@v2.8.3' 2>&1 | tee -a "$LOG"
else
  log "flash-attn already installed"
fi

# ---------------------------------------------------------------------------
# 6. Orchestrator deps (from our pyproject.toml)
# ---------------------------------------------------------------------------
log "Installing orchestrator deps"
uv pip install -r <(python - <<'PY'
import tomllib, pathlib
data = tomllib.loads(pathlib.Path("pyproject.toml").read_text())
for d in data["project"]["dependencies"]:
    print(d)
PY
) 2>&1 | tee -a "$LOG"

# ---------------------------------------------------------------------------
# 7. Smoke: can we import the key things?
# ---------------------------------------------------------------------------
log "Import smoke test"
python - <<'PY' 2>&1 | tee -a "$LOG"
import importlib, sys
mods = ["vllm", "vllm_omni", "flash_attn", "fastapi", "uvicorn",
        "httpx", "soundfile", "supervisor"]
for m in mods:
    try:
        importlib.import_module(m)
        print(f"  OK  {m}")
    except Exception as e:
        print(f"  FAIL {m}: {e}", file=sys.stderr)
        sys.exit(1)
PY

log "Install complete."
log "Next: bash scripts/10_download_weights.sh"
