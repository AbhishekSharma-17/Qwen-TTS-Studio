# Qwen3-TTS — Quick Guide: run a single vLLM server as an API

Goal: spin up **one** Qwen3-TTS vLLM-Omni backend (no orchestrator, no UI, no
supervisord) so another app can call it as a plain OpenAI-compatible HTTP API.

## What gets exposed

Each standalone backend hosts **one** model and serves the OpenAI-compatible
`POST /v1/audio/speech` endpoint on its own port.

| Task           | Model (HF ID)                                     | Local model dir (`./models/`)       | Endpoint URL                    |
|----------------|---------------------------------------------------|-------------------------------------|---------------------------------|
| `CustomVoice`  | `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`            | `Qwen3-TTS-12Hz-1.7B-CustomVoice`   | `http://<host>:8091/v1/audio/speech` |
| `VoiceDesign`  | `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign`            | `Qwen3-TTS-12Hz-1.7B-VoiceDesign`   | `http://<host>:8092/v1/audio/speech` |
| `Base`         | `Qwen/Qwen3-TTS-12Hz-1.7B-Base`                   | `Qwen3-TTS-12Hz-1.7B-Base`          | `http://<host>:8093/v1/audio/speech` |
| _(full stack)_ | all three, routed by `task_type`                  | —                                   | `http://<host>:8080/v1/audio/speech` (orchestrator) |

Default bind is `0.0.0.0` — replace `<host>` with `127.0.0.1` for local,
`<dgx-spark-ip>` from another machine. Override port/host with
`run_standalone.sh <Task> [PORT] [HOST]`. The shared tokenizer
(`Qwen/Qwen3-TTS-Tokenizer-12Hz`) is auto-loaded by every backend — you
don't address it directly.

For OpenAI-SDK clients, pass the HF model ID as the `model` field; for
raw JSON, `task_type` is what routes the request.

---

## 0. Prerequisites (do once)

You already ran these if the full stack works. If not:

```bash
cd /home/genaiprotos/Genaiprotos/qwentts

bash scripts/00_install.sh          # venv, vLLM wheel, vllm-omni, flash-attn (~30–60 min)
bash scripts/10_download_weights.sh # pulls ~13 GB of weights into ./models
```

Verify:

```bash
ls .venv/bin/vllm-omni              # must exist
ls models/Qwen3-TTS-12Hz-1.7B-CustomVoice/config.json
```

If the full stack is currently running (supervisord owns 8091/8092/8093), stop
it first so the port is free:

```bash
bash scripts/stop.sh
```

---

## 1. Pick the task you want to expose

One model per process. Choose **one**:

| Task          | Use it for                                  | Default port | Model dir (under `./models/`)          |
|---------------|---------------------------------------------|--------------|----------------------------------------|
| `CustomVoice` | 9 **preset** speakers (most common choice)  | **8091**     | `Qwen3-TTS-12Hz-1.7B-CustomVoice`      |
| `VoiceDesign` | Invent a voice from a natural-language desc | **8092**     | `Qwen3-TTS-12Hz-1.7B-VoiceDesign`      |
| `Base`        | Clone from a reference audio + transcript   | **8093**     | `Qwen3-TTS-12Hz-1.7B-Base`             |

Preset voices (CustomVoice only): `vivian`, `serena`, `uncle_fu`, `dylan`,
`eric`, `ryan`, `aiden`, `ono_anna`, `sohee`.

---

## 2. Launch the server (pick one command)

All commands are run from the project root (`/home/genaiprotos/Genaiprotos/qwentts`).

### 2.1 Fast path — one-line wrappers (default port, listens on `0.0.0.0`)

```bash
bash scripts/run_customvoice.sh      # preset voices   → http://0.0.0.0:8091
bash scripts/run_voicedesign.sh      # voice design    → http://0.0.0.0:8092
bash scripts/run_base.sh             # voice cloning   → http://0.0.0.0:8093
```

### 2.2 Generic form — pick task, port, bind address

```bash
# Usage:  run_standalone.sh <CustomVoice|VoiceDesign|Base> [PORT] [HOST]

bash scripts/run_standalone.sh CustomVoice              # :8091, 0.0.0.0
bash scripts/run_standalone.sh VoiceDesign 8100         # :8100, 0.0.0.0
bash scripts/run_standalone.sh Base 8200 127.0.0.1      # :8200, localhost only
bash scripts/run_standalone.sh --help
```

### 2.3 What to expect

- First start takes **30–90 s** (weight load + CUDA-graph capture).
- Wait for the line `Uvicorn running on http://<HOST>:<PORT>`.
- Ctrl-C stops the server cleanly (SIGTERM → SIGKILL fallback).

---

## 3. The exposed endpoint

Once you see `Uvicorn running on …`, the backend speaks the same
OpenAI-compatible API the full stack exposes on 8080:

| Method | Path                       | Purpose                                     |
|--------|----------------------------|---------------------------------------------|
| POST   | `/v1/audio/speech`         | Synthesize speech — JSON in, audio out      |
| GET    | `/v1/audio/voices`         | List voices the backend supports            |
| POST   | `/v1/audio/voices`         | Upload a ref clip (Base only, in-memory)    |
| WS     | `/v1/audio/speech/stream`  | WebSocket streaming                          |
| GET    | `/health`                  | Liveness                                     |

Base URL to give your other app:

```
http://<HOST>:<PORT>
# e.g. http://127.0.0.1:8091
```

`task_type` in the JSON body **must match** the model you launched
(you picked `CustomVoice`/`VoiceDesign`/`Base` at launch).

Request body (minimum fields per task):

| Field           | CustomVoice | VoiceDesign | Base                                        |
|-----------------|-------------|-------------|---------------------------------------------|
| `input`         | required    | required    | required                                    |
| `task_type`     | required    | required    | required                                    |
| `voice`         | required    | —           | —                                           |
| `instructions`  | optional    | **required**| optional                                    |
| `ref_audio`     | —           | —           | **required** (URL / `file://` / `data:`)    |
| `ref_text`      | —           | —           | recommended (enables ICL)                   |
| `language`      | optional (`Auto`, `English`, `Chinese`, `Japanese`, `Korean`, `German`, `French`, `Russian`, `Portuguese`, `Spanish`, `Italian`) |
| `response_format` | optional (`wav` default, `mp3`, `flac`, `pcm`, `aac`, `opus`) |
| `stream`        | optional (`true` requires `response_format:"pcm"`)           |
| `speed`         | optional (0.25–4.0)                                          |

---

## 4. Call it from another app

Replace `PORT` with whichever you launched on (8091 / 8092 / 8093 / custom).

### 4.1 curl

```bash
# CustomVoice — preset speaker
curl -sX POST http://127.0.0.1:8091/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"task_type":"CustomVoice","voice":"ryan","language":"English",
       "input":"Hello from the standalone server."}' \
  --output out.wav

# VoiceDesign — describe a voice
curl -sX POST http://127.0.0.1:8092/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"task_type":"VoiceDesign","language":"English",
       "instructions":"a calm, warm, elderly male narrator",
       "input":"Once upon a time..."}' \
  --output narrator.wav

# Base — voice clone (inline base64 reference)
REF=$(base64 -w0 /path/to/ref.wav)
curl -sX POST http://127.0.0.1:8093/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d "{\"task_type\":\"Base\",\"language\":\"English\",
       \"ref_audio\":\"data:audio/wav;base64,${REF}\",
       \"ref_text\":\"Transcript of the reference clip.\",
       \"input\":\"Cloned voice says hello.\"}" \
  --output cloned.wav

# Streaming PCM (sub-second TTFA) — pipe straight into sox `play`
curl -sX POST http://127.0.0.1:8091/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"task_type":"CustomVoice","voice":"vivian",
       "input":"Streaming audio!","stream":true,"response_format":"pcm"}' \
  --no-buffer | play -t raw -r 24000 -e signed -b 16 -c 1 -

# Liveness
curl -s http://127.0.0.1:8091/health
```

### 4.2 Python (httpx)

```python
import httpx, pathlib

r = httpx.post(
    "http://127.0.0.1:8091/v1/audio/speech",
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

### 4.3 OpenAI SDK (drop-in)

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8091/v1", api_key="none")

r = client.audio.speech.create(
    model="Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",   # matches the launched task
    voice="ryan",
    input="The OpenAI SDK talks to our server unchanged.",
)
r.stream_to_file("sdk.wav")
```

### 4.4 Node.js (fetch)

```javascript
import { writeFile } from "node:fs/promises";

const r = await fetch("http://127.0.0.1:8091/v1/audio/speech", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    task_type: "CustomVoice",
    voice: "ryan",
    language: "English",
    input: "Hello from Node.",
  }),
});
if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
await writeFile("hello.wav", Buffer.from(await r.arrayBuffer()));
```

---

## 5. Running it in the background / headless

### 5.1 `nohup` (simplest)

```bash
nohup bash scripts/run_customvoice.sh > logs/standalone_customvoice.log 2>&1 &
echo $! > /tmp/qwen3_customvoice.pid

# stop later:
kill -TERM "$(cat /tmp/qwen3_customvoice.pid)"
```

### 5.2 `tmux`

```bash
tmux new -d -s qwen3tts 'bash scripts/run_customvoice.sh'
tmux attach -t qwen3tts         # detach with Ctrl-B then D
```

### 5.3 SSH port-forward from your laptop

If the backend is bound to `127.0.0.1` only (e.g. `run_standalone.sh
CustomVoice 8091 127.0.0.1`), forward it:

```bash
ssh -L 8091:127.0.0.1:8091 <dgx-spark-host>
# then hit http://127.0.0.1:8091 from your laptop
```

For a production systemd unit or nginx reverse-proxy, see
[`docs/GUIDE.md` §11.10](GUIDE.md#1110-deployment-patterns).

---

## 6. Common gotchas

- **Port in use** → the full stack owns 8091/8092/8093. `bash scripts/stop.sh`
  first, or launch on a different port (`run_standalone.sh CustomVoice 8100`).
- **`task_type` mismatch** → the JSON `task_type` must match the model you
  launched. Sending `"task_type":"Base"` to a CustomVoice backend returns
  `"Unsupported voice"` / `400`.
- **Only one model per process** → need all three concurrently? Use the full
  stack (`bash scripts/start.sh`) — supervisord runs all three on 8091/8092/8093
  behind the orchestrator on 8080.
- **Uploaded ref voices are in-memory only in standalone mode** → restart
  wipes them. Use the full stack's orchestrator for a persistent voice library.
- **Out of memory** when running multiple standalone processes → each stage
  reserves `STAGE_GPU_MEM_UTIL` (default 0.15) × 2 stages per model. Lower it
  in `.env` or stick to one standalone backend at a time.

---

## 7. Using it from LiveKit Agents

LiveKit Agents can drive this server as the TTS in a realtime voice pipeline
(STT → LLM → **TTS → WebRTC**). Both streaming paths emit raw PCM @ 24 kHz
mono 16-bit — matches LiveKit's `AudioEmitter` natively, no resampling needed.

**Full guide → [`docs/LIVEKIT.md`](LIVEKIT.md)** — covers the two integration
paths, the custom `QwenTTS` class, preset / designed / cloned voices with
worked examples, multilingual switching, a runnable end-to-end entrypoint,
and production gotchas.

Shortest possible start:

```bash
# 1. On the DGX: launch the backend you want to expose.
bash scripts/run_customvoice.sh              # :8091

# 2. In your LiveKit worker's venv:
pip install "livekit-agents[openai,deepgram,silero]~=1.3" httpx

# 3. Point the OpenAI TTS plugin at our server (works for plain preset voices).
#    For language switching, voice design, or cloning — use the QwenTTS class
#    from docs/LIVEKIT.md §3 instead.
```

```python
from livekit.plugins import openai
tts = openai.TTS(
    base_url="http://<dgx-host>:8091/v1",
    api_key="unused",
    model="Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
    voice="ryan",
    response_format="pcm",
)
```

---

## 8. TL;DR — the 30-second path

```bash
cd /home/genaiprotos/Genaiprotos/qwentts
bash scripts/stop.sh                                    # only if full stack is running
bash scripts/run_customvoice.sh                         # wait for "Uvicorn running on ..."

# from any other app, in another shell:
curl -sX POST http://127.0.0.1:8091/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"task_type":"CustomVoice","voice":"ryan","input":"Hello."}' \
  --output out.wav
```

Base URL to hand your app: **`http://127.0.0.1:8091`** (or 8092 / 8093 for the
other two tasks).
