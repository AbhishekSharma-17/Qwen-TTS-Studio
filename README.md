# Qwen3-TTS Studio — DGX Spark

Production-grade local TTS stack: FastAPI orchestrator in front of **three concurrent
vLLM-Omni Qwen3-TTS backends** (CustomVoice / VoiceDesign / Base), with a plain
HTML/CSS/JS single-page UI. Streams PCM audio to the browser via WebAudio for
sub-second time-to-first-audio.

Built for: NVIDIA DGX Spark (GB10 Grace-Blackwell, aarch64, CUDA 13).

## At a glance

- **UI**: `http://127.0.0.1:8080/` (localhost only)
- **API**: OpenAI-compatible `POST /v1/audio/speech` (plus extensions)
- **Models resident**: all 3, ~20 GB of 128 GB unified memory
- **Tasks**: preset voices (9), describe-a-voice, voice-cloning from a ref clip
- **Languages**: Chinese, English, Japanese, Korean, German, French, Russian, Portuguese, Spanish, Italian + Auto

## Quick start

```bash
# 1. Clone
git clone https://github.com/AbhishekSharma-17/Qwen-TTS-Studio.git
cd Qwen-TTS-Studio

# 2. Configure environment
cp .env.example .env
sed -i "s|REPLACE_WITH_ABSOLUTE_PATH|$(pwd)|g" .env

# 3. One-time install (~30-60 min; flash-attn compile dominates)
# Creates uv venv, installs vLLM aarch64 wheel for cu130, clones + patches
# vllm-omni, builds flash-attn from source, installs FastAPI deps.
bash scripts/00_install.sh

# 4. Download model weights from Hugging Face (~13 GB)
bash scripts/10_download_weights.sh
```

## Run

```bash
bash scripts/start.sh       # starts supervisord with 4 services
bash scripts/logs.sh        # tail all logs (Ctrl-C to stop tailing)
bash scripts/smoke_test.sh  # verifies every endpoint
bash scripts/stop.sh        # graceful shutdown
```

Open http://127.0.0.1:8080/ in a browser. If running headless, use SSH port
forwarding: `ssh -L 8080:127.0.0.1:8080 <dgx-spark-host>`.

## Services

| Service | Port | What it does |
|---|---|---|
| `orchestrator` | 8080 | FastAPI, serves UI + proxies to backends |
| `vllm_customvoice` | 8091 | Qwen3-TTS-12Hz-1.7B-CustomVoice (9 preset voices) |
| `vllm_voicedesign` | 8092 | Qwen3-TTS-12Hz-1.7B-VoiceDesign (prompt-designed voice) |
| `vllm_base` | 8093 | Qwen3-TTS-12Hz-1.7B-Base (voice cloning) |

## API quick reference

```bash
# Preset voice (CustomVoice)
curl -sX POST http://127.0.0.1:8080/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"task_type":"CustomVoice","voice":"ryan","language":"English",
       "input":"Hello from the DGX Spark."}' \
  --output out.wav

# Describe-a-voice (VoiceDesign)
curl -sX POST http://127.0.0.1:8080/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"task_type":"VoiceDesign","language":"English",
       "instructions":"a calm, warm, elderly male narrator",
       "input":"Once upon a time, deep in a quiet forest..."}' \
  --output narrator.wav

# Stream PCM (for real-time playback)
curl -sX POST http://127.0.0.1:8080/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"task_type":"CustomVoice","voice":"vivian",
       "input":"Streaming audio!","stream":true,"response_format":"pcm"}' \
  --no-buffer | play -t raw -r 24000 -e signed -b 16 -c 1 -

# Upload a voice clone sample
curl -sX POST http://127.0.0.1:8080/v1/audio/voices \
  -F "audio_sample=@/path/to/my_voice.wav" \
  -F "consent=ui-$(date +%s)" \
  -F "name=my_narrator" \
  -F "ref_text=Transcript of the sample I recorded." \
  -F "speaker_description=warm narrator voice"

# Use the cloned voice
curl -sX POST http://127.0.0.1:8080/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"task_type":"Base","input":"Cloned!","ref_voice":"my_narrator"}' \
  --output cloned.wav
```

## Performance targets (GB10, single user)

| Task | Time-to-first-audio | Total for ~50 chars |
|---|---|---|
| CustomVoice preset | < 250 ms | ~1.0 s |
| VoiceDesign | < 350 ms | ~1.2 s |
| Base (voice clone, 8 s ref) | < 700 ms | ~1.8 s |

## Troubleshooting

- **`supervisorctl` says backend exited**: check `logs/<service>.log`. Most
  common cause on first run: flash-attn build failed. Re-run
  `scripts/00_install.sh` with `MAX_JOBS=2`.
- **"Unsupported voice"**: you sent a CustomVoice name to a Base/VoiceDesign
  backend. The orchestrator route picks the backend from `task_type`.
- **Port already in use**: `bash scripts/stop.sh` first, or edit `.env` to use
  different ports.
- **Out of memory**: raise `STAGE_GPU_MEM_UTIL` cautiously in `.env`, or flip
  VoiceDesign to lazy-loaded in `configs/supervisord.conf`.

## Layout

```
Qwen-TTS-Studio/
├── .env.example               # template; copy to .env and set ROOT_DIR
├── .venv/                     # uv-managed Python 3.12 (created by installer)
├── models/                    # model store (fetched from Hugging Face)
├── vllm-omni/                 # patched vllm-omni (cloned by installer)
├── configs/
│   ├── qwen3_tts_dgx.yaml     # vLLM-Omni stage config
│   └── supervisord.conf.tpl   # process manager template (rendered at start)
├── orchestrator/              # FastAPI
├── static/                    # UI (HTML/CSS/JS, no framework)
├── data/
│   ├── voices/                # uploaded reference audio (runtime)
│   └── voices.example.json    # empty catalog template
├── docs/                      # README + full operator GUIDE (md + pdf)
├── scripts/                   # install + lifecycle
└── logs/                      # runtime (created on first start)
```

See [`docs/GUIDE.md`](docs/GUIDE.md) for the full operator guide, API reference,
voice-cloning best practices, and troubleshooting.

## Licences & attribution

- **This repository** (FastAPI orchestrator, UI, scripts, configs) — Apache
  License 2.0. See [`LICENSE`](LICENSE).
- **Qwen3-TTS model weights** — released by Alibaba under Apache 2.0. Not
  redistributed here; fetched from Hugging Face by
  [`scripts/10_download_weights.sh`](scripts/10_download_weights.sh).
  See the Hugging Face model cards:
  - [Qwen/Qwen3-TTS-Tokenizer-12Hz](https://huggingface.co/Qwen/Qwen3-TTS-Tokenizer-12Hz)
  - [Qwen/Qwen3-TTS-12Hz-1.7B-Base](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base)
  - [Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice)
  - [Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign)
- **vLLM-Omni** — Apache 2.0 upstream. Not redistributed; cloned and patched
  in-place by [`scripts/00_install.sh`](scripts/00_install.sh).

Published by [GenAI Protos](./GenAI%20Protos%20Logo/). Built for NVIDIA DGX
Spark (GB10 Grace-Blackwell, aarch64, CUDA 13).
