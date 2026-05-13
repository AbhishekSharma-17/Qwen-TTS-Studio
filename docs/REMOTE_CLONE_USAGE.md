# Using the cloned-voice TTS service from a remote device

Goal: you've already uploaded and saved your voice to the library on the DGX
Spark, and now you want to call it from **another machine on your Tailscale
network** (e.g. an agent host, a Claude-Code worker, your laptop). Minimum
moving parts, lowest GPU footprint, simplest integration.

---

## TL;DR

1. **Only two services are needed** on the DGX for clone-only use:
   * **Orchestrator** on `:8080` — owns the voice library, resolves
     `ref_voice: "my_voice"` to your saved reference audio.
   * **Base backend** on `:8093` — does the actual voice cloning.
2. **Unload** CustomVoice and VoiceDesign to free their ~4.3 GB each of GPU.
3. **Bind the orchestrator to `0.0.0.0`** so Tailscale peers can reach it.
4. **Call it** from your remote app like any OpenAI-compatible speech endpoint.

---

## Step 1 — On the DGX: keep only what you need

```bash
cd /home/genaiprotos/Genaiprotos/qwentts

# Free 8.6 GB of GPU — only Base stays loaded
curl -X POST http://127.0.0.1:8080/v1/admin/models/CustomVoice/unload
curl -X POST http://127.0.0.1:8080/v1/admin/models/VoiceDesign/unload

# Confirm
curl -s http://127.0.0.1:8080/v1/admin/models | python3 -m json.tool
# Expect: "Base" status "up", the other two "stopped"
```

## Step 2 — On the DGX: expose the orchestrator over Tailscale

By default the orchestrator binds `127.0.0.1` (localhost only). Switch it
to `0.0.0.0` so it accepts Tailscale traffic. The Tailscale ACL is your
auth layer.

```bash
cd /home/genaiprotos/Genaiprotos/qwentts

# Switch bind address
sed -i 's/^ORCH_HOST=.*/ORCH_HOST=0.0.0.0/' .env
grep ^ORCH_ .env             # sanity-check
bash scripts/restart.sh      # reload supervisord with the new value
```

Get the DGX's Tailscale IP and write it down — you'll use it from the remote
device:

```bash
tailscale ip -4 | head -1    # e.g. 100.123.45.67
```

## Step 3 — On the remote device: confirm connectivity

Replace `100.x.y.z` with the IP from Step 2.

```bash
# Health probe
curl -s http://100.x.y.z:8080/health | python3 -m json.tool
# Expect: status "healthy" or "degraded", "base": "up"

# List voices — yours should be in "uploaded_voices"
curl -s http://100.x.y.z:8080/v1/audio/voices | python3 -m json.tool
```

If both work, you're done with setup. Everything below is integration.

---

## Step 4 — Use it

Everywhere below, `BASE_URL` is `http://100.x.y.z:8080` (the DGX's Tailscale IP)
and `VOICE_NAME` is whatever you named your saved voice (e.g. `my_narrator`).

### A · curl one-liner

```bash
curl -sX POST http://100.x.y.z:8080/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{
    "task_type": "Base",
    "input": "Generated from a remote device over Tailscale.",
    "ref_voice": "my_narrator",
    "language": "English"
  }' --output out.wav
```

### B · Python (httpx — minimal)

```python
import httpx, pathlib

DGX = "http://100.x.y.z:8080"
VOICE = "my_narrator"

def speak(text: str, out: str = "out.wav", *, instructions: str | None = None) -> str:
    body = {
        "task_type": "Base",
        "ref_voice": VOICE,
        "language": "English",
        "input": text,
    }
    if instructions:
        body["instructions"] = instructions
    r = httpx.post(f"{DGX}/v1/audio/speech", json=body, timeout=300)
    r.raise_for_status()
    pathlib.Path(out).write_bytes(r.content)
    return out

speak("Hello from my agent.")
```

### C · OpenAI SDK drop-in

```python
from openai import OpenAI

client = OpenAI(base_url="http://100.x.y.z:8080/v1", api_key="none")

r = client.audio.speech.create(
    model="Qwen/Qwen3-TTS-12Hz-1.7B-Base",
    voice="ignored-for-Base",   # field is mandatory in the SDK but ignored
    input="Hello from my agent.",
    extra_body={
        "task_type": "Base",
        "ref_voice": "my_narrator",
        "language": "English",
    },
)
r.stream_to_file("out.wav")
```

### D · Streaming PCM for low time-to-first-audio

If your agent does real-time playback (live voice UI, telephony, conversational
loop), use streaming. First audio arrives in ~200–500 ms instead of 1+ s.

```python
import httpx, asyncio, sounddevice as sd

async def stream_speak(text):
    async with httpx.AsyncClient(timeout=None) as c:
        async with c.stream(
            "POST", "http://100.x.y.z:8080/v1/audio/speech",
            json={
                "task_type": "Base",
                "ref_voice": "my_narrator",
                "language": "English",
                "input": text,
                "stream": True,
                "response_format": "pcm",
            },
        ) as r:
            r.raise_for_status()
            tail = b""
            with sd.RawOutputStream(samplerate=24000, channels=1, dtype="int16") as out:
                async for chunk in r.aiter_bytes():
                    buf = tail + chunk
                    even = len(buf) & ~1
                    out.write(buf[:even])
                    tail = buf[even:]

asyncio.run(stream_speak("Streaming straight into the speakers."))
```

### E · Shell function (drop into `~/.bashrc` or your agent's PATH)

```bash
# Usage: qwen-say "Some text"
qwen-say() {
  local text="${1:?give me text to say}"
  local out="${2:-/tmp/qwen_say.wav}"
  curl -sf -X POST http://100.x.y.z:8080/v1/audio/speech \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc \
        --arg t "$text" \
        --arg v "my_narrator" \
        '{task_type:"Base", ref_voice:$v, language:"English", input:$t}')" \
    --output "$out" && echo "wrote $out"
}
```

---

## For an agent (Claude Code / function-calling models)

Drop this tool definition into your agent's toolset. It uses your saved
clone voice and returns a path to the generated audio.

```python
# tts_tool.py — register with your agent's function-calling framework

import httpx, pathlib, time

DGX_BASE = "http://100.x.y.z:8080"
DEFAULT_VOICE = "my_narrator"

def tts_speak(text: str,
              out_dir: str = "/tmp",
              language: str = "English",
              instructions: str | None = None,
              voice_name: str | None = None) -> str:
    """Synthesise `text` in the user's saved cloned voice. Returns the
    absolute path to a WAV file.

    Args:
        text: The exact text to speak. ≤ 8000 chars.
        out_dir: Directory to write the WAV to.
        language: One of: Auto, English, Chinese, Japanese, Korean, German,
                  French, Russian, Portuguese, Spanish, Italian. Note: this is
                  a pronunciation hint, NOT a translation flag — the model
                  speaks the text exactly as given.
        instructions: Optional one-line style hint, e.g. "with excitement".
        voice_name: Override the saved-voice name (defaults to my_narrator).
    """
    body = {
        "task_type": "Base",
        "ref_voice": voice_name or DEFAULT_VOICE,
        "language": language,
        "input": text,
    }
    if instructions:
        body["instructions"] = instructions
    r = httpx.post(f"{DGX_BASE}/v1/audio/speech", json=body, timeout=300)
    r.raise_for_status()
    out = pathlib.Path(out_dir) / f"qwen_tts_{int(time.time()*1000)}.wav"
    out.write_bytes(r.content)
    return str(out)


# OpenAI-style JSON schema for function-calling agents
TTS_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "tts_speak",
        "description": (
            "Convert text to speech in the user's saved cloned voice and "
            "return the path to a WAV file. The model does NOT translate — "
            "pass text in the language you want spoken, and set `language` "
            "to match it. Use `instructions` for tone/emotion/pacing."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "Text to speak (≤ 8000 chars)"},
                "language": {
                    "type": "string",
                    "enum": ["Auto", "English", "Chinese", "Japanese", "Korean",
                             "German", "French", "Russian", "Portuguese",
                             "Spanish", "Italian"],
                    "default": "English"
                },
                "instructions": {
                    "type": "string",
                    "description": "Optional one-line style hint (e.g. 'with excitement', 'slowly and clearly')"
                }
            },
            "required": ["text"]
        }
    }
}
```

Then in your agent runtime:

```python
# Example: hand-roll a tool-using loop with the openai client
from openai import OpenAI
from tts_tool import tts_speak, TTS_TOOL_SCHEMA

llm = OpenAI()  # whatever LLM your agent uses
messages = [{"role": "user", "content": "Say in a calm tone: dinner is ready."}]

r = llm.chat.completions.create(
    model="gpt-4o-mini",         # or whichever
    messages=messages,
    tools=[TTS_TOOL_SCHEMA],
)
call = r.choices[0].message.tool_calls[0]
args = json.loads(call.function.arguments)
wav_path = tts_speak(**args)
# play the wav, send to telephony, etc.
```

For Claude Code (the CLI agent), drop `tts_tool.py` anywhere on `PYTHONPATH`
and either expose it as a `mcp__*` tool or just import + call directly from
inline code blocks.

---

## Useful diagnostics

```bash
# Which voices are saved (their names)
curl -s http://100.x.y.z:8080/v1/audio/voices | jq -r '.uploaded_voices[].name'

# Backend health
curl -s http://100.x.y.z:8080/health | jq

# If clone calls hang, peek at the Base log on the DGX:
tail -f /home/genaiprotos/Genaiprotos/qwentts/logs/base.log

# Re-load the other two backends if you change your mind
curl -X POST http://100.x.y.z:8080/v1/admin/models/CustomVoice/load?wait=true
curl -X POST http://100.x.y.z:8080/v1/admin/models/VoiceDesign/load?wait=true
```

---

## Performance expectations

| Operation | Time on DGX Spark + Tailscale LAN |
|---|---|
| First clone request after backend load | ~1–2 s |
| Subsequent clone requests (short text) | 0.7–1.2 s |
| Streaming time-to-first-audio | ~300–500 ms incl. Tailscale RTT |
| Bandwidth for streamed PCM | 384 kbps (= 24 kHz × 16-bit × 1 channel) |
| Bandwidth for buffered WAV | one file per request, ~80 KB / sec of audio |

Tailscale adds 10–40 ms RTT typically. Streaming PCM hides this — your first
chunk arrives while later chunks are still being decoded on the DGX.

---

## Security note

You're binding `0.0.0.0:8080`. That means **anyone on the Tailscale network
can hit the endpoint with no auth**. Mitigations, in order of effort:

1. **Tailscale ACL** (recommended) — in your Tailscale admin console, restrict
   `tag:tts-server` (your DGX) to accept inbound `tcp:8080` only from
   `tag:tts-client` (your trusted devices). Five lines of HuJSON.
2. **Bearer token** — add a check in `orchestrator/app.py`'s lifespan: read
   `QWENTTS_TOKEN` env var; reject requests without matching
   `Authorization: Bearer <token>`. ~10 LOC.
3. **mTLS via Caddy / Nginx in front** — terminate TLS and verify client
   certs. Heaviest, most secure.

For a personal Tailnet, option 1 is plenty.

---

## Reverting to localhost-only

When you're done remote-using:

```bash
cd /home/genaiprotos/Genaiprotos/qwentts
sed -i 's/^ORCH_HOST=.*/ORCH_HOST=127.0.0.1/' .env
bash scripts/restart.sh
```

Or load the other backends back when you want the full UI again:

```bash
curl -X POST http://127.0.0.1:8080/v1/admin/models/all/load
```
