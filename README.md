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

## Run a single model (standalone / embedding mode)

When you want to embed Qwen3-TTS in another app and **don't need the UI,
voice-library persistence, or all three task types at once**, launch just
one backend directly. No orchestrator, no supervisord — a single
`vllm-omni` process exposing the OpenAI-compatible speech API on its own
port. Ctrl-C for a clean shutdown.

```bash
bash scripts/run_customvoice.sh                       # preset speakers      :8091
bash scripts/run_voicedesign.sh                       # voice design         :8092
bash scripts/run_base.sh                              # voice clone          :8093

# Or the generic form — pick task, port, bind address:
bash scripts/run_standalone.sh CustomVoice            # default :8091 on 0.0.0.0
bash scripts/run_standalone.sh VoiceDesign 8100       # on :8100
bash scripts/run_standalone.sh Base 8200 127.0.0.1    # localhost-only bind
bash scripts/run_standalone.sh --help                 # full usage
```

Each script:

- Verifies the venv + model weights exist, and that the chosen port is free
- Prints a banner with the exact endpoint URL and a ready-to-paste curl example
- First launch takes ~30–90 s (weight load + CUDA-graph capture) — wait for `Uvicorn running on http://…`
- Traps SIGINT/SIGTERM for clean shutdown

**When to choose standalone vs full stack:**

| Situation | Standalone | Full stack |
|---|---|---|
| Single task type, embed in your app | ✅ | ✅ |
| All three tasks needed at once | ❌ | ✅ |
| Browser UI / voice library | ❌ | ✅ |
| Smallest footprint, simplest deploy | ✅ | — |

See [`docs/GUIDE.md` §11](docs/GUIDE.md#11-standalone-single-model-mode--integration-guide)
for full integration examples (Python, Node.js, OpenAI SDK, systemd unit,
reverse-proxy patterns).

## Services

| Service | Port | What it does |
|---|---|---|
| `orchestrator` | 8080 | FastAPI, serves UI + proxies to backends |
| `vllm_customvoice` | 8091 | Qwen3-TTS-12Hz-1.7B-CustomVoice (9 preset voices) |
| `vllm_voicedesign` | 8092 | Qwen3-TTS-12Hz-1.7B-VoiceDesign (prompt-designed voice) |
| `vllm_base` | 8093 | Qwen3-TTS-12Hz-1.7B-Base (voice cloning) |

## API reference

Full stack exposes the orchestrator on `:8080`. Each standalone backend
(from the `run_*.sh` scripts) exposes the same `/v1/audio/speech` endpoint
on its own port.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/audio/speech` | Synthesise speech (JSON in, audio out) |
| `GET` | `/v1/audio/voices` | List built-in speakers + uploaded voices |
| `POST` | `/v1/audio/voices` | Upload a reference voice for cloning (`multipart/form-data`) |
| `DELETE` | `/v1/audio/voices/{name}` | Remove a cloned voice (orchestrator only — persistent) |
| `GET` | `/v1/audio/voices/{name}/preview` | Stream the stored reference clip back |
| `WS` | `/v1/audio/speech/stream` | WebSocket: streaming text-in, per-sentence PCM audio-out |
| `GET` | `/health` | Overall + per-backend status |
| `GET` | `/info` | Capabilities, models, features |
| `GET` | `/v1/admin/models` | Per-model status (orchestrator only) |
| `POST` | `/v1/admin/models/{task}/load` | Load a backend (orchestrator only) |
| `POST` | `/v1/admin/models/{task}/unload` | Unload a backend (orchestrator only) |

### Request body — `POST /v1/audio/speech`

| Field | Required for | Notes |
|---|---|---|
| `input` | all | Text to speak (≤ 8 000 chars) |
| `task_type` | all | `CustomVoice`, `VoiceDesign`, or `Base` |
| `voice` | CustomVoice | `vivian`, `serena`, `uncle_fu`, `dylan`, `eric`, `ryan`, `aiden`, `ono_anna`, `sohee` |
| `instructions` | VoiceDesign (required) / others (optional) | Free-form style / emotion / description |
| `ref_audio` | Base | HTTP URL, `file://…`, or `data:audio/wav;base64,…` |
| `ref_text` | Base (recommended) | Exact transcript of `ref_audio` — enables ICL mode |
| `ref_voice` | Base (orchestrator only) | Name of a saved library voice |
| `language` | optional | `Auto`, `English`, `Chinese`, `Japanese`, `Korean`, `German`, `French`, `Russian`, `Portuguese`, `Spanish`, `Italian` |
| `response_format` | optional | `wav` (default), `mp3`, `flac`, `pcm`, `aac`, `opus` |
| `stream` | optional | `true` requires `response_format: "pcm"` — chunks of raw 16-bit PCM @ 24 kHz mono |
| `speed` | optional | 0.25 – 4.0 (ignored if streaming) |

### curl — common cases

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

# Stream PCM (real-time playback)
curl -sX POST http://127.0.0.1:8080/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"task_type":"CustomVoice","voice":"vivian",
       "input":"Streaming audio!","stream":true,"response_format":"pcm"}' \
  --no-buffer | play -t raw -r 24000 -e signed -b 16 -c 1 -

# Upload a voice clone sample (persisted + mirrored to Base backend)
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

### Python (httpx)

```python
import httpx, pathlib

r = httpx.post(
    "http://127.0.0.1:8080/v1/audio/speech",
    json={
        "task_type": "CustomVoice",
        "voice": "ryan",
        "language": "English",
        "input": "Hello from Python.",
    },
    timeout=300,
)
r.raise_for_status()
pathlib.Path("hello.wav").write_bytes(r.content)
```

### OpenAI SDK (drop-in)

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8080/v1", api_key="none")

r = client.audio.speech.create(
    model="Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
    voice="ryan",
    input="The OpenAI SDK talks to our server unchanged.",
)
r.stream_to_file("sdk.wav")
```

### Node.js (fetch)

```javascript
import { writeFile } from "node:fs/promises";

const r = await fetch("http://127.0.0.1:8080/v1/audio/speech", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    task_type: "VoiceDesign",
    language: "English",
    instructions: "a warm elderly narrator",
    input: "Once upon a time…",
  }),
});
if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
await writeFile("narrator.wav", Buffer.from(await r.arrayBuffer()));
```

### Integrating in another app

1. **Pick a mode** — full stack (`:8080`, task routing + UI + voice library)
   or standalone (`:8091 / 8092 / 8093`, one task per port, embedded deploy).
2. **Call `/v1/audio/speech`** from your code — same schema on either mode.
3. **For low TTFA**, use `stream: true` + `response_format: "pcm"` and play
   chunks as they arrive (see [`docs/GUIDE.md` §11.6](docs/GUIDE.md#116-python--async-streaming-pcm-real-time-playback)).
4. **Persist cloned voices** via the full stack's `/v1/audio/voices` POST
   — standalone Base uploads are in-memory only.
5. **Production deployment** — systemd unit / Nginx reverse-proxy / CI job
   worker patterns are documented in
   [`docs/GUIDE.md` §11.10](docs/GUIDE.md#1110-deployment-patterns).

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

Built for NVIDIA DGX Spark (GB10 Grace-Blackwell, aarch64, CUDA 13).
