# Qwen3-TTS × LiveKit Agents — Integration Guide

Use the Qwen3-TTS Studio as the TTS backend for a **LiveKit Agents** voice
pipeline (STT → LLM → **TTS → WebRTC**). Everything the standalone server
offers — 9 preset speakers, "describe-a-voice" (VoiceDesign), and voice
cloning (Base) — is available to LiveKit via one small Python class.

Companion to [`QUICKGUIDE.md`](QUICKGUIDE.md) (how to run the server) and
[`GUIDE.md`](GUIDE.md) (the full operator manual). This file focuses
**only** on the LiveKit side.

## What LiveKit will point at

One `base_url` per backend. **The shape differs by path — this matters**:

| Path                              | `base_url` shape              | Why                                                                      |
|-----------------------------------|-------------------------------|--------------------------------------------------------------------------|
| **`QwenTTS`** (custom class, §3)  | `http://<host>:<port>`        | The class appends `/v1/audio/speech` internally — **don't** add `/v1`.   |
| **`openai.TTS`** (plugin, §4)     | `http://<host>:<port>/v1`     | The OpenAI SDK appends `/audio/speech` — you **must** include `/v1` here.|

The full endpoint hit in both cases is the same: `POST /v1/audio/speech`.
Only the `base_url` string you pass differs.

`QwenTTS` base URLs (per task):

| Task          | Model (HF ID)                             | `base_url` for `QwenTTS(...)`        | `task_type` value |
|---------------|-------------------------------------------|--------------------------------------|-------------------|
| CustomVoice   | `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`    | `http://<dgx>:8091`                  | `"CustomVoice"`   |
| VoiceDesign   | `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign`    | `http://<dgx>:8092`                  | `"VoiceDesign"`   |
| Base (clone)  | `Qwen/Qwen3-TTS-12Hz-1.7B-Base`           | `http://<dgx>:8093`                  | `"Base"`          |
| Full stack    | all three, routed by `task_type`          | `http://<dgx>:8080` (orchestrator)   | any               |

`openai.TTS` base URLs are the same values **plus `/v1`** — e.g.
`http://<dgx>:8091/v1` for CustomVoice.

Replace `<dgx>` with the DGX Spark's IP / hostname, or `127.0.0.1` if the
LiveKit worker runs on the same box.

---

## Table of contents

1. [Architecture](#1-architecture)
2. [Prerequisites](#2-prerequisites)
3. [The `QwenTTS` class](#3-the-qwentts-class)
4. [Path A — OpenAI plugin (simplest, limited)](#4-path-a--openai-plugin-simplest-limited)
5. [Preset voices (CustomVoice)](#5-preset-voices-customvoice)
6. [Designed voices (VoiceDesign)](#6-designed-voices-voicedesign)
7. [Cloned voices (Base)](#7-cloned-voices-base)
8. [Multilingual](#8-multilingual)
9. [Mixing all three task types in one session](#9-mixing-all-three-task-types-in-one-session)
10. [Full runnable entrypoint](#10-full-runnable-entrypoint)
11. [Parameter reference](#11-parameter-reference)
12. [Performance & tuning](#12-performance--tuning)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Architecture

```
   ┌──────────────────┐   WebRTC    ┌──────────────────────────────────┐
   │ Browser / phone  │◀───────────▶│   LiveKit SFU (cloud or self)    │
   └──────────────────┘             └──────────────────────────────────┘
                                                  ▲  ▼  (room)
                                    ┌─────────────────────────────────┐
                                    │   LiveKit Agents worker         │
                                    │   ─ STT  (Deepgram / OpenAI…)   │
                                    │   ─ LLM  (OpenAI / Anthropic…)  │
                                    │   ─ TTS  ── QwenTTS ──▶ HTTP    │
                                    └────────────────┬────────────────┘
                                                     │  /v1/audio/speech
                                                     ▼
                                    ┌─────────────────────────────────┐
                                    │   Qwen3-TTS vLLM-Omni backend   │
                                    │   CustomVoice :8091             │
                                    │   VoiceDesign :8092             │
                                    │   Base        :8093             │
                                    │   (or orchestrator :8080)       │
                                    └─────────────────────────────────┘
```

- The Qwen server streams raw **16-bit PCM @ 24 kHz mono** — which is
  exactly what LiveKit's `AudioEmitter` wants with `mime_type="audio/pcm"`.
  No resampling, no format conversion.
- The LiveKit worker is a separate Python process (your code). It can run
  on the same DGX Spark as the Qwen server (lowest latency) or anywhere
  that can reach its HTTP port.

---

## 2. Prerequisites

**On the DGX Spark (this repo):** one or more standalone backends running.

```bash
cd /home/genaiprotos/Genaiprotos/qwentts
bash scripts/run_customvoice.sh      # :8091  preset voices
bash scripts/run_voicedesign.sh      # :8092  describe-a-voice
bash scripts/run_base.sh             # :8093  voice cloning
# — or —
bash scripts/start.sh                # full stack (orchestrator :8080 routes to all three)
```

Wait for `Uvicorn running on http://0.0.0.0:<port>` before continuing.

**In your LiveKit worker project (a separate venv / repo):**

```bash
pip install "livekit-agents[openai,deepgram,silero]~=1.3" httpx
```

**LiveKit + API keys** (`.env` in your LiveKit worker project):

```bash
# LiveKit cloud / self-hosted SFU
LIVEKIT_URL=wss://<your-livekit-host>
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...

# LLM + STT (swap providers as you like)
OPENAI_API_KEY=...
DEEPGRAM_API_KEY=...

# Qwen3-TTS server
QWEN_TTS_URL=http://<dgx-spark-ip>:8091      # CustomVoice
# QWEN_VD_URL=http://<dgx-spark-ip>:8092     # VoiceDesign  (optional)
# QWEN_BASE_URL=http://<dgx-spark-ip>:8093   # Base         (optional)
# QWEN_ORCH_URL=http://<dgx-spark-ip>:8080   # full stack   (optional)
```

If the worker runs **off** the DGX Spark, either bind your standalone
servers to `0.0.0.0` (default) and open the ports on your firewall, or
forward them over SSH:

```bash
ssh -L 8091:127.0.0.1:8091 dgx
# now http://127.0.0.1:8091 works on your laptop
```

---

## 3. The `QwenTTS` class

Drop this file into your LiveKit worker as `qwen_tts.py`. It subclasses
LiveKit's `tts.TTS` and streams raw PCM directly into `AudioEmitter` so
time-to-first-audio is sub-second once the server is warm.

```python
# qwen_tts.py
from __future__ import annotations

import httpx
from livekit.agents import tts, utils
from livekit.agents.types import APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS


class QwenTTS(tts.TTS):
    """
    LiveKit TTS plugin for a Qwen3-TTS vLLM-Omni backend.

    One QwenTTS instance is pinned to ONE task_type (CustomVoice /
    VoiceDesign / Base) because each standalone backend only serves
    one model. For multi-task apps, see §9 (mix three instances) or
    point base_url at the orchestrator on :8080.
    """

    def __init__(
        self,
        *,
        base_url: str = "http://127.0.0.1:8091",
        task_type: str = "CustomVoice",          # "CustomVoice" | "VoiceDesign" | "Base"
        voice: str = "ryan",                     # CustomVoice only
        language: str = "English",               # or "Auto", "Chinese", "Japanese", ...
        instructions: str | None = None,         # required for VoiceDesign
        ref_audio: str | None = None,            # Base: URL | file:// | data:audio/...
        ref_text: str | None = None,             # Base: transcript (enables ICL)
        ref_voice: str | None = None,            # orchestrator-only: saved library voice
        speed: float = 1.0,
        api_key: str = "unused",                 # server ignores the value
        request_timeout_s: float = 300.0,
    ):
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False),
            sample_rate=24000,
            num_channels=1,
        )
        self._base_url = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {api_key}"}
        self._opts = dict(
            task_type=task_type, voice=voice, language=language,
            instructions=instructions, ref_audio=ref_audio, ref_text=ref_text,
            ref_voice=ref_voice, speed=speed,
        )
        self._http = httpx.AsyncClient(timeout=httpx.Timeout(request_timeout_s, connect=15))

    @property
    def model(self) -> str:
        return f"qwen3-tts-{self._opts['task_type'].lower()}"

    @property
    def provider(self) -> str:
        return "qwen-tts"

    def update_options(self, **kwargs) -> None:
        """Mutate any field between utterances — e.g. language='Chinese'."""
        for k, v in kwargs.items():
            if k in self._opts:
                self._opts[k] = v

    def synthesize(
        self,
        text: str,
        *,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ):
        return _QwenStream(tts=self, input_text=text, conn_options=conn_options)

    async def aclose(self):
        await self._http.aclose()


class _QwenStream(tts.ChunkedStream):
    async def _run(self, output_emitter: tts.AudioEmitter) -> None:
        o = self._tts._opts

        payload = {
            "task_type":       o["task_type"],
            "input":           self.input_text,
            "language":        o["language"],
            "response_format": "pcm",
            "stream":          True,
            "speed":           o["speed"],
        }
        if o["task_type"] == "CustomVoice":
            payload["voice"] = o["voice"]
        if o["instructions"]:
            payload["instructions"] = o["instructions"]
        if o["task_type"] == "Base":
            if o["ref_voice"]:
                payload["ref_voice"] = o["ref_voice"]          # orchestrator only
            elif o["ref_audio"]:
                payload["ref_audio"] = o["ref_audio"]
                if o["ref_text"]:
                    payload["ref_text"] = o["ref_text"]
            else:
                raise ValueError("QwenTTS(task_type='Base') needs ref_audio or ref_voice")

        output_emitter.initialize(
            request_id=utils.shortuuid(),
            sample_rate=24000,
            num_channels=1,
            mime_type="audio/pcm",
        )
        url = f"{self._tts._base_url}/v1/audio/speech"
        async with self._tts._http.stream(
            "POST", url, json=payload, headers=self._tts._headers,
        ) as r:
            r.raise_for_status()
            async for chunk in r.aiter_bytes():
                if chunk:
                    output_emitter.push(chunk)
        output_emitter.flush()
```

### What each piece does

| Piece                                | Why it's there                                                                                   |
|--------------------------------------|---------------------------------------------------------------------------------------------------|
| `super().__init__(sample_rate=24000, num_channels=1)` | Declares the PCM format LiveKit will hand to WebRTC. Matches the Qwen stream exactly. |
| `TTSCapabilities(streaming=False)`  | LiveKit's "streaming=True" is only for token-by-token WS TTS. We use HTTP chunked streaming — `_run` still emits PCM chunks as they arrive. |
| `update_options(**kw)`               | The only supported way to change language/voice/instructions mid-session — `AgentSession` has no `language=` kwarg. |
| `_QwenStream._run(output_emitter)`   | Called by LiveKit once per utterance. It builds the JSON body, POSTs with `stream=true`, and forwards every chunk of bytes to the emitter. |
| `output_emitter.initialize(mime_type="audio/pcm", sample_rate=24000, num_channels=1)` | Tells the emitter how to re-frame raw bytes into `rtc.AudioFrame`s for WebRTC. |
| `response_format="pcm"` + `stream=True` (fixed) | Required for LiveKit. Don't let users change this — other formats would need a decoder. |
| `api_key="unused"` default           | The openai-SDK-style `Authorization: Bearer …` header is harmless; the Qwen server ignores it. |

---

## 4. Path A — OpenAI plugin (simplest, limited)

If you only need preset voices in one fixed language, you can skip the
custom class and use `livekit-plugins-openai` directly — it accepts a
`base_url`:

```python
from livekit.plugins import openai

tts = openai.TTS(
    base_url="http://<dgx-host>:8091/v1",
    api_key="unused",
    model="Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
    voice="ryan",
    response_format="pcm",
    speed=1.0,
    instructions="Speak in a warm, conversational tone.",
)
```

**Limits** — the OpenAI plugin's request body is a fixed kwarg list and
cannot carry `task_type`, `language`, `ref_audio`, `ref_text`, or
`ref_voice`. If you need any of those (multilingual, voice design,
cloning) use `QwenTTS` from §3 instead.

The rest of this guide uses `QwenTTS`.

---

## 5. Preset voices (CustomVoice)

Nine studio-quality voices, each tuned for a particular language/accent.
Use `task_type="CustomVoice"` and pick a `voice`:

| Voice name   | Style / best for                                    |
|--------------|-----------------------------------------------------|
| `ryan`       | Neutral male English — a safe default               |
| `vivian`     | Bright female Mandarin                              |
| `serena`     | Warm female, multilingual                           |
| `uncle_fu`   | Older Sichuan Chinese male, storyteller             |
| `dylan`      | Clear male narrator, European languages             |
| `eric`       | Confident male, good for German / Russian           |
| `aiden`      | Energetic younger male, French / English            |
| `ono_anna`   | Female Japanese                                     |
| `sohee`      | Female Korean                                       |

### 5.1 Minimal example

Start: `bash scripts/run_customvoice.sh` (port 8091). Then in your
LiveKit worker:

```python
from qwen_tts import QwenTTS

qwen = QwenTTS(
    base_url="http://127.0.0.1:8091",
    task_type="CustomVoice",
    voice="ryan",
    language="English",
    speed=1.0,
)

# inside your entrypoint():
session = AgentSession(
    stt=deepgram.STT(model="nova-3"),
    llm=openai.LLM(model="gpt-4o-mini"),
    tts=qwen,
    vad=silero.VAD.load(),
)
await session.start(agent=Agent(instructions="You are a friendly assistant."),
                    room=ctx.room)

await session.say("Hi! I'm Ryan, the default preset voice.")
```

### 5.2 Change voice mid-session

```python
await session.say("This is Ryan.")
qwen.update_options(voice="vivian", language="Chinese")
await session.say("这是薇薇安，我讲中文。")
qwen.update_options(voice="ono_anna", language="Japanese")
await session.say("アンナです、日本語で話します。")
```

### 5.3 Tweak tone / emotion with `instructions`

`CustomVoice` optionally accepts free-form instructions to nudge style:

```python
qwen = QwenTTS(
    base_url="http://127.0.0.1:8091",
    task_type="CustomVoice",
    voice="ryan",
    instructions="speak slower and more softly, like reading a bedtime story",
)
await session.say("Once upon a time, in a quiet forest...")
```

### 5.4 Speed

`speed` is 0.25 – 4.0. Note: **ignored when streaming**, which is
always the case from LiveKit (the class hard-codes `stream=True`). If you
need slower playback for an accessibility use case, either (a) accept
that `speed` won't apply in realtime mode, or (b) pre-synth long prompts
off-stream via plain HTTP in your worker.

---

## 6. Designed voices (VoiceDesign)

Invent a new voice from a natural-language description — no preset, no
reference clip. Use `task_type="VoiceDesign"` and make `instructions`
carry the description.

Start: `bash scripts/run_voicedesign.sh` (port 8092).

### 6.1 Basic example

```python
from qwen_tts import QwenTTS

narrator = QwenTTS(
    base_url="http://127.0.0.1:8092",
    task_type="VoiceDesign",
    language="English",
    instructions=(
        "a calm, warm, elderly male narrator with a slow, reassuring pace "
        "and a slight British accent"
    ),
)

session = AgentSession(stt=..., llm=..., tts=narrator, vad=...)
await session.start(agent=Agent(instructions="You read stories aloud."),
                    room=ctx.room)
await session.say("Once upon a time, deep in a quiet forest, a small fox...")
```

### 6.2 Writing good descriptions

`instructions` in VoiceDesign is the whole voice — be specific.
Dimensions that matter most:

- **Age**: _young child_, _teenager_, _young adult_, _middle-aged_, _elderly_
- **Gender / timbre**: _male_, _female_, _androgynous_, _bright_, _raspy_, _breathy_
- **Accent**: _British_, _American Southern_, _Indian English_, _Japanese-accented English_, _Parisian French_, …
- **Pace**: _slow and deliberate_, _conversational_, _fast and excited_
- **Emotion / mood**: _calm_, _excited_, _serious_, _warm_, _professional_, _playful_
- **Role / context (optional)**: _news anchor_, _audiobook narrator_, _radio DJ_, _teacher_

Good examples:

```text
"a bright, cheerful young woman in her mid-20s, fast and energetic pace,
neutral American accent, warm and approachable tone"

"a deep, authoritative middle-aged male with a slight newscaster cadence,
measured and clear, no accent"

"an elderly Japanese-accented English speaker, soft and gentle,
with a contemplative pace"
```

### 6.3 Change voice personality mid-session

```python
narrator.update_options(
    instructions="a bright, energetic teenage girl, excited and fast, American accent"
)
await session.say("Oh my gosh, this is so cool!")
```

Each call re-synthesises from the new description — same backend, no
re-launch, first-chunk latency is still sub-second once warm.

### 6.4 Combine with `language`

`instructions` describes the voice; `language` tells the model which
language to speak. Both work together:

```python
narrator = QwenTTS(
    base_url="http://127.0.0.1:8092",
    task_type="VoiceDesign",
    language="Spanish",
    instructions="a professional female news anchor, formal tone, clear diction",
)
await session.say("Buenas noches, y bienvenidos al noticiero de las nueve.")
```

---

## 7. Cloned voices (Base)

Clone a voice from a reference audio clip plus (optionally) a transcript.

Start: `bash scripts/run_base.sh` (port 8093). Standalone Base keeps
uploaded refs **in memory only** — restart wipes them. For a persistent
voice library, use the orchestrator route in §7.4.

### 7.1 Reference-clip tips

- 3 – 15 seconds of clean mono speech, 16 kHz+ sample rate (WAV/MP3/FLAC).
- Single speaker, no background music or crowd noise.
- Matching language helps (English clip → best English cloning).
- Provide `ref_text` (the exact transcript) when possible — enables ICL
  mode and noticeably raises fidelity.

### 7.2 Inline base64 `data:` URI (easiest, self-contained)

```python
import base64, pathlib
from qwen_tts import QwenTTS

ref_bytes = pathlib.Path("./my_voice_sample.wav").read_bytes()
ref_uri = "data:audio/wav;base64," + base64.b64encode(ref_bytes).decode()

clone = QwenTTS(
    base_url="http://127.0.0.1:8093",
    task_type="Base",
    language="English",
    ref_audio=ref_uri,
    ref_text="This is exactly what I said in the sample I just uploaded.",
)

await session.say("Hello — this is my cloned voice reading a new sentence.")
```

### 7.3 HTTP URL or `file://` reference

If the Qwen server can reach the ref by URL, you can skip the base64:

```python
clone = QwenTTS(
    base_url="http://127.0.0.1:8093",
    task_type="Base",
    language="English",
    ref_audio="https://example.com/my_voice_sample.wav",
    ref_text="Transcript of the file at the URL above.",
)
```

`file:///absolute/path/on/the/server.wav` also works when the LiveKit
worker runs on the same box as the Qwen server.

### 7.4 Persistent library — use the orchestrator

Run the full stack (`bash scripts/start.sh`) so uploaded voices persist
on disk:

```bash
# 1. Upload once via the orchestrator (persists to data/voices/)
curl -sX POST http://127.0.0.1:8080/v1/audio/voices \
  -F "audio_sample=@./my_voice_sample.wav" \
  -F "consent=livekit-app-$(date +%s)" \
  -F "name=my_narrator" \
  -F "ref_text=Transcript of the sample I recorded." \
  -F "speaker_description=warm narrator voice"
```

```python
# 2. From LiveKit — point at the orchestrator and use ref_voice=name
clone = QwenTTS(
    base_url="http://127.0.0.1:8080",        # orchestrator, not the :8093 backend
    task_type="Base",
    language="English",
    ref_voice="my_narrator",                  # library name — no ref_audio needed
)
await session.say("Hi, I'm your saved narrator voice.")
```

(`ref_voice` is orchestrator-only; it resolves to an on-disk file.
Standalone Base does not know about the library.)

### 7.5 Swap cloned voices mid-session

```python
clone.update_options(ref_voice="voice_a"); await session.say("This is voice A.")
clone.update_options(ref_voice="voice_b"); await session.say("This is voice B.")
```

Or for inline clips:

```python
clone.update_options(ref_audio=uri_b, ref_text="B's transcript.")
```

---

## 8. Multilingual

`AgentSession` has **no `language=` kwarg** — change language through the
TTS, not the session.

Supported values (server-side):

```
Auto · English · Chinese · Japanese · Korean · German · French ·
Russian · Portuguese · Spanish · Italian
```

### 8.1 Static — one language per session

```python
qwen = QwenTTS(base_url=..., task_type="CustomVoice",
               voice="ono_anna", language="Japanese")
session = AgentSession(tts=qwen, ...)
await session.say("こんにちは、今日はいい天気ですね。")
```

### 8.2 Dynamic — switch per utterance

```python
qwen = QwenTTS(base_url=..., task_type="CustomVoice",
               voice="ryan", language="English")

await session.say("Hello in English.")
qwen.update_options(language="Chinese", voice="vivian")
await session.say("你好，这是中文。")
qwen.update_options(language="Spanish", voice="serena")
await session.say("Hola, esto es en español.")
```

### 8.3 Auto-pick voice + language from detected STT language

Deepgram (and most STT plugins) return a 2-letter language hint on the
final transcript. Map it to a Qwen language/voice pair:

```python
LANG_TO_VOICE = {
    "en": ("English",    "ryan"),
    "zh": ("Chinese",    "vivian"),
    "ja": ("Japanese",   "ono_anna"),
    "ko": ("Korean",     "sohee"),
    "de": ("German",     "eric"),
    "fr": ("French",     "aiden"),
    "es": ("Spanish",    "serena"),
    "it": ("Italian",    "dylan"),
    "pt": ("Portuguese", "uncle_fu"),
    "ru": ("Russian",    "eric"),
}

@session.on("user_input_transcribed")
def _on_transcript(ev):
    if ev.is_final and getattr(ev, "language", None):
        lang, voice = LANG_TO_VOICE.get(ev.language[:2], ("Auto", "ryan"))
        qwen.update_options(language=lang, voice=voice)
```

Now the assistant answers in whatever language the user spoke last.

### 8.4 Let the model auto-detect

If you don't want to think about language at all, set `language="Auto"`.
Handles mixed-language text cleanly too:

```python
qwen.update_options(language="Auto")
await session.say("Mixed: Hello, 你好, こんにちは, hola.")
```

---

## 9. Mixing all three task types in one session

Each standalone backend only serves one task. If one session needs a
preset voice for the assistant, a designed narrator for a story segment,
**and** a cloned caller voice — either:

**Option 1**: three `QwenTTS` instances, one per backend port. Reassign
`session.tts` at the moment you need a different voice.

```python
preset = QwenTTS(base_url="http://127.0.0.1:8091", task_type="CustomVoice", voice="ryan")
designed = QwenTTS(base_url="http://127.0.0.1:8092", task_type="VoiceDesign",
                   instructions="a calm elderly male narrator")
cloned = QwenTTS(base_url="http://127.0.0.1:8093", task_type="Base",
                 ref_audio=ref_uri, ref_text="...")

session = AgentSession(tts=preset, ...)
await session.say("I'll now tell you a story.")

session.tts = designed
await session.say("Once upon a time, deep in a forest...")

session.tts = cloned
await session.say("And this is how the traveler spoke.")
```

**Option 2**: run the full stack and point one `QwenTTS` at the
orchestrator on `:8080` — flip `task_type` via `update_options` and the
orchestrator routes each request to the matching backend. Simpler code,
but one extra process.

```python
qwen = QwenTTS(base_url="http://127.0.0.1:8080", task_type="CustomVoice", voice="ryan")
await session.say("Preset.")

qwen.update_options(task_type="VoiceDesign",
                    instructions="a calm elderly male narrator")
await session.say("Designed.")

qwen.update_options(task_type="Base", ref_voice="my_narrator")
await session.say("Cloned.")
```

---

## 10. Full runnable entrypoint

Drop-in example. Assumes `qwen_tts.py` sits next to this file and the
env vars in §2 are set.

```python
# main.py
import os
from livekit.agents import Agent, AgentSession, JobContext, WorkerOptions, cli
from livekit.plugins import deepgram, openai, silero

from qwen_tts import QwenTTS

LANG_TO_VOICE = {
    "en": ("English",    "ryan"),
    "zh": ("Chinese",    "vivian"),
    "ja": ("Japanese",   "ono_anna"),
    "ko": ("Korean",     "sohee"),
    "es": ("Spanish",    "serena"),
    "fr": ("French",     "aiden"),
    "de": ("German",     "eric"),
}


async def entrypoint(ctx: JobContext):
    await ctx.connect()

    qwen = QwenTTS(
        base_url=os.environ["QWEN_TTS_URL"],        # http://<dgx>:8091
        task_type="CustomVoice",
        voice="ryan",
        language="English",
    )

    session = AgentSession(
        stt=deepgram.STT(model="nova-3", detect_language=True),
        llm=openai.LLM(model="gpt-4o-mini"),
        tts=qwen,
        vad=silero.VAD.load(),
    )

    @session.on("user_input_transcribed")
    def _match_language(ev):
        if ev.is_final and getattr(ev, "language", None):
            lang, voice = LANG_TO_VOICE.get(ev.language[:2], ("Auto", "ryan"))
            qwen.update_options(language=lang, voice=voice)

    await session.start(
        agent=Agent(instructions=(
            "You are a helpful multilingual voice assistant. "
            "Reply in whatever language the user just spoke."
        )),
        room=ctx.room,
    )

    await session.say("Hello! Feel free to speak to me in any major language.")


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
```

Run it:

```bash
python main.py dev       # connects as a dev worker to your LiveKit URL
```

Test from a browser: open your LiveKit playground (or any LiveKit app)
against the same room the worker joined.

---

## 11. Parameter reference

### 11.1 `QwenTTS(...)` constructor & `update_options(...)`

| Param            | Type    | CustomVoice | VoiceDesign | Base                            | Notes                                                                     |
|------------------|---------|-------------|-------------|---------------------------------|---------------------------------------------------------------------------|
| `base_url`       | str     | required    | required    | required                        | `http://<host>:<port>` of the running backend                             |
| `task_type`      | str     | required    | required    | required                        | Must match the backend's launched task                                    |
| `voice`          | str     | **required**| —           | —                               | `vivian`, `serena`, `uncle_fu`, `dylan`, `eric`, `ryan`, `aiden`, `ono_anna`, `sohee` |
| `language`       | str     | optional    | optional    | optional                        | `Auto`, `English`, `Chinese`, `Japanese`, `Korean`, `German`, `French`, `Russian`, `Portuguese`, `Spanish`, `Italian` |
| `instructions`   | str     | optional    | **required**| optional                        | Free-form description — tone/age/accent/pace/emotion                      |
| `ref_audio`      | str     | —           | —           | **required**¹                   | URL, `file://…`, or `data:audio/wav;base64,…`                             |
| `ref_text`       | str     | —           | —           | optional (strongly recommended) | Exact transcript of `ref_audio` — enables ICL                             |
| `ref_voice`      | str     | —           | —           | **required**¹ (orch only)       | Name of a library voice saved via the orchestrator                        |
| `speed`          | float   | optional    | optional    | optional                        | 0.25 – 4.0 — **ignored when streaming** (which is always true in LiveKit) |
| `api_key`        | str     | optional    | optional    | optional                        | Server ignores value; `"unused"` is fine                                  |
| `request_timeout_s` | float | optional  | optional    | optional                        | httpx per-request timeout. Bump if utterances are very long.              |

¹ For `task_type="Base"`: provide **either** `ref_audio` (+ optional `ref_text`) **or** `ref_voice`. The latter only works when `base_url` is the orchestrator.

### 11.2 Fixed by `QwenTTS`, not user-tunable

- `response_format="pcm"` · `stream=True` · `sample_rate=24000` · `channels=1`
- `mime_type="audio/pcm"` on the emitter

These are what LiveKit wants natively — don't override them unless you're
also rewriting the PCM→WebRTC path.

### 11.3 LiveKit-side knobs worth knowing

- `AgentSession(vad=silero.VAD.load())` — VAD gates when the user is
  "done" speaking. Keep it, otherwise the assistant interrupts itself.
- `deepgram.STT(detect_language=True)` — populates `ev.language` for the
  auto-pick pattern in §8.3. Without it you'll always get `"en"`.
- `session.say(text, allow_interruptions=True)` — let the user barge-in
  while Qwen is still speaking. Recommended for realistic conversation.

---

## 12. Performance & tuning

| Knob                    | Effect                                                                 |
|-------------------------|------------------------------------------------------------------------|
| Worker on the DGX Spark | Lowest latency — loopback HTTP only.                                   |
| Worker on LAN           | ~1–3 ms network adds; still fine for realtime.                         |
| Worker over WAN         | Noticeable. Compress with TLS + HTTP/2 reverse proxy, or co-locate.    |
| Warm-up                 | First synth does CUDA graph capture (~30–90 s). Fire a throwaway curl before your LiveKit worker accepts rooms, or do an early `session.say("Ready.")` and accept the one-time wait. |
| `STAGE_GPU_MEM_UTIL`    | In `.env`, controls per-stage GPU memory. Raise it for bigger batches, lower it to free memory. |
| Multiple LiveKit rooms  | Qwen server handles `max_num_seqs: 4` per stage by default (see `configs/qwen3_tts_dgx.yaml`). Above that, calls queue — bump `max_num_seqs` or run a second backend on another port. |
| Barge-in / interruptions | LiveKit cancels the pending `synthesize()` — `httpx.stream` closes the TCP connection, the server stops streaming. Clean. |

Time-to-first-audio once warm (single user, on-DGX worker):

| Task        | TTFA    | Total for ~50 chars |
|-------------|---------|----------------------|
| CustomVoice | < 250 ms | ~1.0 s               |
| VoiceDesign | < 350 ms | ~1.2 s               |
| Base (8 s ref) | < 700 ms | ~1.8 s             |

---

## 13. Troubleshooting

| Symptom                                              | Likely cause / fix                                                                                                                         |
|------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------|
| `HTTP 422 Unprocessable Entity`                      | `task_type` doesn't match the launched backend. Run `run_customvoice.sh` to serve `CustomVoice` requests, etc.                             |
| `HTTP 400 "Unsupported voice"`                       | Sent a CustomVoice voice name to a VoiceDesign / Base backend. Fix `base_url` or `task_type`.                                              |
| `HTTP 400 "ref_audio required"` (Base)               | You picked `task_type="Base"` but didn't pass `ref_audio` or `ref_voice`. See §7.                                                          |
| First `session.say()` takes 60+ s                    | CUDA graph warm-up. Normal on first request. Warm with a throwaway curl, or accept the wait.                                               |
| Chopped audio / crackles                             | Network congestion between LiveKit worker and the Qwen server. Move the worker closer or use port-forwarding.                              |
| `ConnectionRefusedError` from `QwenTTS`              | The backend isn't running, or `base_url` / port is wrong. Hit `GET {base_url}/health` by hand.                                             |
| Voice doesn't match `instructions` (VoiceDesign)     | Descriptions are suggestions, not constraints. Try more concrete dimensions (age + gender + accent + pace) and retry.                      |
| Cloned voice sounds off                              | Ref clip is noisy, too short, or wrong language. Aim for 8–12 s of clean speech in the target language; always pass `ref_text`.            |
| `language` passes but accent sounds wrong            | `Auto` sometimes picks a different language than intended when text is ambiguous. Set `language` explicitly.                               |
| `AudioEmitter: unknown mime_type`                    | You're on an old `livekit-agents` — pin `~=1.3` and re-run `pip install`.                                                                  |
| OpenAI plugin rejects `api_key=""`                   | Known — pass `"unused"` (or any non-empty string).                                                                                         |
| Worker logs `task_type missing`                      | You're calling the standalone backend with the OpenAI plugin (path A). Switch to `QwenTTS` (path B) so `task_type` is sent.                |
| Speed setting has no effect                          | `speed` is ignored when streaming (which is always true in LiveKit). Expected.                                                             |
| Multiple LiveKit rooms, one backend, requests queue  | Raise `max_num_seqs` in `configs/qwen3_tts_dgx.yaml`, or run a second backend on a different port.                                         |

---

## See also

- [`QUICKGUIDE.md`](QUICKGUIDE.md) — how to launch the server, curl / Python / OpenAI SDK examples
- [`GUIDE.md`](GUIDE.md) — full operator manual, voice-cloning best practices
- [`README.md`](../README.md) — architecture overview, API reference
- LiveKit Agents docs — <https://docs.livekit.io/agents/>
- `livekit-plugins-openai` TTS source — <https://github.com/livekit/agents/blob/main/livekit-plugins/livekit-plugins-openai/livekit/plugins/openai/tts.py>
- LiveKit base `tts.TTS` / `AudioEmitter` — <https://github.com/livekit/agents/blob/main/livekit-agents/livekit/agents/tts/tts.py>
