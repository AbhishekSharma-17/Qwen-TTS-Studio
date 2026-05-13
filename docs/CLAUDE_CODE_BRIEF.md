# Qwen TTS Clone Service — Integration Brief

> **Hand this whole file to Claude Code as context. Ask: "build a TTS wrapper around this service so my video generator can call it."**

You are integrating with a self-hosted text-to-speech service running on a
DGX Spark on the same Tailscale network as the calling device. There is **no
SDK, no client library, and no auth** — it's a plain HTTP JSON service. Build
whatever wrapper is idiomatic for the language and framework you're using.

---

## 1. Service info

| Property | Value |
|---|---|
| **Base URL (Tailscale)** | `http://100.111.8.126:8020` |
| **Protocol** | HTTP/1.1, JSON in, binary audio out |
| **Auth** | None — restricted to Tailscale peers |
| **CORS** | Not set — server-side calls only, or reverse-proxy if browser-side |
| **Network** | Both caller and server must be on the same Tailnet |
| **Service health probe** | `GET /health` |

The service hosts a **single useful endpoint** for this use-case:

```
POST /v1/audio/speech
```

Plus two helpers:

```
GET  /v1/audio/voices   →  lists available cloned voices (JSON)
GET  /health            →  service health (JSON)
```

That's it. No streaming setup, no session, no API key. Stateless HTTP.

---

## 2. Available cloned voices

Two voices are pre-saved on the server. **Names are case-sensitive.**

| `ref_voice` | Belongs to | Native language |
|---|---|---|
| `Abhishek` | Abhishek Sharma | English |
| `Hari` | Hariharan Arulmozhi | English |

Both voices can speak any of the 11 supported languages, but English is what
they sound most natural in (since the reference clips were recorded in
English).

---

## 3. The request

### Method + path

```
POST /v1/audio/speech
Content-Type: application/json
```

### JSON body

```json
{
  "task_type": "Base",
  "ref_voice": "Abhishek",
  "input": "The text you want spoken.",
  "language": "English",
  "instructions": "Speak clearly with a calm tone",
  "response_format": "wav",
  "stream": false
}
```

### Field reference

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `task_type` | string | **yes** | — | Always set to `"Base"` for voice-cloning |
| `ref_voice` | string | **yes** | — | `"Abhishek"` or `"Hari"`. Case-sensitive |
| `input` | string | **yes** | — | The exact text to speak. Max 8000 chars. Model does **not** translate — text is spoken as-given |
| `language` | string | recommended | `"Auto"` | Pronunciation hint, not translation. One of: `Auto`, `English`, `Chinese`, `Japanese`, `Korean`, `German`, `French`, `Russian`, `Portuguese`, `Spanish`, `Italian` |
| `instructions` | string | optional | `""` | Free-form one-line style hint: `"with excitement"`, `"slowly and clearly"`, `"as a whisper"`, `"sound urgent"`, etc. |
| `response_format` | string | optional | `"wav"` | One of `wav`, `mp3`, `flac`, `pcm`, `aac`, `opus` |
| `speed` | float | optional | `1.0` | Range 0.25–4.0. Ignored when `stream: true` |
| `stream` | bool | optional | `false` | `true` requires `response_format: "pcm"`. Streams raw 16-bit LE PCM at 24 kHz mono |
| `max_new_tokens` | int | optional | `2048` | Hard cap on codec tokens; raise for very long inputs |

### Important: language is a hint, not a translator

If you send `input: "Hello world"` with `language: "Chinese"`, the model
tries to speak the English words "Hello world" using Chinese phonetics —
which sounds wrong. **Always set `language` to match the language of
`input`**. If your video script has multiple languages, split it into
segments per language and call the API once per segment.

---

## 4. The response

### Success (HTTP 200)

Binary audio body with `Content-Type` matching `response_format`:

| `response_format` | `Content-Type` |
|---|---|
| `wav` | `audio/wav` |
| `mp3` | `audio/mpeg` |
| `flac` | `audio/flac` |
| `pcm` | `audio/L16; rate=24000; channels=1` (raw 16-bit LE PCM, 24 kHz, mono) |
| `aac` | `audio/aac` |
| `opus` | `audio/ogg` |

Default `wav` is the easiest — write the response body straight to a file
with the `.wav` extension and any media player or audio library accepts it.

### Errors

```json
{ "detail": "VoiceDesign task requires 'instructions' describing the voice" }
```

| Code | Meaning | Common cause |
|---|---|---|
| `400` | Bad request body | Missing required field, unknown `ref_voice` |
| `404` | `ref_voice` not in library | Wrong case (use `Abhishek` not `abhishek`) |
| `413` | Reference upload too large | (Only on `POST /v1/audio/voices`, not on speech generation) |
| `500` | Backend internal error | Check `/health`; service may be cold-starting |
| `503` | Backend not ready | Wait 60 s for cold start, retry |

For a video-generation pipeline, the safe pattern is: retry once after a
5-second wait on `503`, fail fast otherwise.

---

## 5. Canonical curl call

```bash
curl -sX POST http://100.111.8.126:8020/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{
        "task_type":   "Base",
        "ref_voice":   "Abhishek",
        "input":       "This is segment three of the intro.",
        "language":    "English",
        "instructions":"with warmth",
        "response_format": "wav"
      }' \
  --output segment_03.wav
```

Verify it worked:

```bash
ls -lh segment_03.wav        # should be 50–200 KB for a short segment
file segment_03.wav          # should report "RIFF ... WAVE audio"
```

---

## 6. HTTP examples in major languages

### Node.js (fetch — built-in in Node 18+)

```javascript
import { writeFile } from "node:fs/promises";

async function speak({ text, voice = "Abhishek", language = "English", instructions, out }) {
  const r = await fetch("http://100.111.8.126:8020/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      task_type: "Base",
      ref_voice: voice,
      language,
      input: text,
      ...(instructions ? { instructions } : {}),
    }),
  });
  if (!r.ok) throw new Error(`TTS ${r.status}: ${await r.text()}`);
  await writeFile(out, Buffer.from(await r.arrayBuffer()));
  return out;
}

await speak({ text: "Welcome to the show.", voice: "Hari", out: "intro.wav" });
```

### Python (requests)

```python
import requests, pathlib

def speak(text, voice="Abhishek", language="English",
          instructions=None, out="out.wav"):
    body = {"task_type": "Base", "ref_voice": voice,
            "language": language, "input": text}
    if instructions:
        body["instructions"] = instructions
    r = requests.post("http://100.111.8.126:8020/v1/audio/speech",
                      json=body, timeout=300)
    r.raise_for_status()
    pathlib.Path(out).write_bytes(r.content)
    return out

speak("Welcome to the show.", voice="Hari", out="intro.wav")
```

### Go (net/http)

```go
package main

import (
    "bytes"
    "encoding/json"
    "io"
    "net/http"
    "os"
    "time"
)

type ttsReq struct {
    TaskType       string `json:"task_type"`
    RefVoice       string `json:"ref_voice"`
    Input          string `json:"input"`
    Language       string `json:"language,omitempty"`
    Instructions   string `json:"instructions,omitempty"`
    ResponseFormat string `json:"response_format,omitempty"`
}

func speak(text, voice, out string) error {
    body, _ := json.Marshal(ttsReq{
        TaskType: "Base", RefVoice: voice,
        Language: "English", Input: text,
    })
    cli := &http.Client{Timeout: 5 * time.Minute}
    resp, err := cli.Post("http://100.111.8.126:8020/v1/audio/speech",
        "application/json", bytes.NewReader(body))
    if err != nil { return err }
    defer resp.Body.Close()
    if resp.StatusCode != 200 {
        b, _ := io.ReadAll(resp.Body)
        return &httpErr{Status: resp.StatusCode, Body: string(b)}
    }
    f, _ := os.Create(out); defer f.Close()
    _, err = io.Copy(f, resp.Body)
    return err
}

type httpErr struct{ Status int; Body string }
func (e *httpErr) Error() string { return e.Body }
```

### PHP (cURL)

```php
function speak($text, $voice = "Abhishek", $out = "out.wav") {
    $body = json_encode([
        "task_type" => "Base",
        "ref_voice" => $voice,
        "language"  => "English",
        "input"     => $text,
    ]);
    $ch = curl_init("http://100.111.8.126:8020/v1/audio/speech");
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $body,
        CURLOPT_HTTPHEADER => ["Content-Type: application/json"],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 300,
    ]);
    $audio = curl_exec($ch);
    if (curl_getinfo($ch, CURLINFO_HTTP_CODE) !== 200) {
        throw new Exception("TTS error: " . $audio);
    }
    file_put_contents($out, $audio);
    return $out;
}
```

### Rust (reqwest)

```rust
use std::path::Path;
use serde_json::json;

async fn speak(text: &str, voice: &str, out: &Path) -> anyhow::Result<()> {
    let cli = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300)).build()?;
    let r = cli.post("http://100.111.8.126:8020/v1/audio/speech")
        .json(&json!({
            "task_type": "Base",
            "ref_voice": voice,
            "language":  "English",
            "input":     text,
        }))
        .send().await?;
    let bytes = r.error_for_status()?.bytes().await?;
    std::fs::write(out, bytes)?;
    Ok(())
}
```

---

## 7. The video-segment use case (the one you actually want)

A video generator splits a script into N segments with timing metadata. For
each segment, call the TTS endpoint once and write the resulting WAV
alongside the rest of the segment artefacts. Sketch:

### Bash — sequential

```bash
#!/usr/bin/env bash
# narrate_segments.sh — read segments.tsv, write a wav per row
# segments.tsv format:  segment_id<TAB>voice<TAB>style<TAB>text
set -euo pipefail
mkdir -p segments

while IFS=$'\t' read -r id voice style text; do
  out="segments/${id}.wav"
  curl -sf -X POST http://100.111.8.126:8020/v1/audio/speech \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc \
        --arg t "$text" --arg v "$voice" --arg s "$style" \
        '{task_type:"Base", ref_voice:$v, language:"English",
          input:$t, instructions:$s}')" \
    --output "$out"
  echo "wrote $out  (segment $id, voice $voice)"
done < segments.tsv
```

### Python — concurrent (3 in flight, picks up after failures)

Best when you have many segments and want to keep the GPU busy.

```python
# narrate.py — concurrent segment-to-wav generator
import asyncio, httpx, json, pathlib, sys

BASE = "http://100.111.8.126:8020"
MAX_PARALLEL = 3        # 3 is comfortable for a single DGX; raise if quiet

async def speak(client, segment):
    """segment = dict with: id, voice, language, text, instructions?"""
    out = pathlib.Path("segments") / f"{segment['id']}.wav"
    if out.exists():
        return out, "skip"
    body = {
        "task_type": "Base",
        "ref_voice": segment["voice"],
        "language":  segment.get("language", "English"),
        "input":     segment["text"],
    }
    if segment.get("instructions"):
        body["instructions"] = segment["instructions"]
    for attempt in range(3):
        try:
            r = await client.post(f"{BASE}/v1/audio/speech", json=body, timeout=300)
            r.raise_for_status()
            out.write_bytes(r.content)
            return out, "ok"
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 503 and attempt < 2:
                await asyncio.sleep(5)         # cold start; retry once
                continue
            raise

async def main(plan_json):
    pathlib.Path("segments").mkdir(exist_ok=True)
    plan = json.loads(pathlib.Path(plan_json).read_text())
    sem = asyncio.Semaphore(MAX_PARALLEL)
    async with httpx.AsyncClient() as client:
        async def go(seg):
            async with sem:
                p, st = await speak(client, seg)
                print(f"{st:5s}  {p}")
        await asyncio.gather(*(go(s) for s in plan["segments"]))

if __name__ == "__main__":
    asyncio.run(main(sys.argv[1]))
```

Plan file format (`segments.json`):

```json
{
  "segments": [
    { "id": "001-intro",   "voice": "Hari",      "text": "Welcome to today's update.", "instructions": "with warmth" },
    { "id": "002-news-a",  "voice": "Abhishek",  "text": "Item one. The first headline." },
    { "id": "003-news-b",  "voice": "Abhishek",  "text": "Item two. The second.",        "instructions": "sound urgent" },
    { "id": "004-outro",   "voice": "Hari",      "text": "Thanks for watching.",         "instructions": "with warmth" }
  ]
}
```

Run:

```bash
python narrate.py segments.json
# → segments/001-intro.wav, 002-news-a.wav, …
```

### Node.js — concurrent with `Promise.allSettled`

```javascript
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const BASE = "http://100.111.8.126:8020";
const MAX_PARALLEL = 3;

async function speak(segment, outDir) {
  const body = {
    task_type: "Base",
    ref_voice: segment.voice,
    language:  segment.language ?? "English",
    input:     segment.text,
    ...(segment.instructions ? { instructions: segment.instructions } : {}),
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`${BASE}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      const out = path.join(outDir, `${segment.id}.wav`);
      await writeFile(out, Buffer.from(await r.arrayBuffer()));
      return out;
    }
    if (r.status === 503 && attempt < 2) {
      await new Promise(res => setTimeout(res, 5000));
      continue;
    }
    throw new Error(`segment ${segment.id} → ${r.status}: ${await r.text()}`);
  }
}

export async function narrate(plan, outDir = "segments") {
  await mkdir(outDir, { recursive: true });
  const queue = [...plan.segments];
  const inflight = new Set();
  while (queue.length || inflight.size) {
    while (queue.length && inflight.size < MAX_PARALLEL) {
      const seg = queue.shift();
      const p = speak(seg, outDir)
        .then(out => { console.log("ok    ", out); inflight.delete(p); })
        .catch(err => { console.error("FAIL  ", seg.id, err.message); inflight.delete(p); });
      inflight.add(p);
    }
    await Promise.race(inflight);
  }
}
```

---

## 8. Building the wrapper — what Claude Code should produce

When you (Claude Code) wrap this for the video generator, aim for this
shape. Adjust to your project's language and conventions.

### Public surface

```text
TtsClient(base_url, default_voice="Abhishek", default_language="English")
  ├── speak(text, voice?, language?, instructions?, format="wav") -> bytes
  ├── speak_to_file(text, out_path, …) -> str
  ├── narrate_plan(plan, out_dir, concurrency=3) -> list[str]
  ├── list_voices() -> list[str]
  └── health() -> dict
```

### Behaviour the wrapper should provide on top of raw HTTP

1. **Connection pooling / keepalive** — reuse a single HTTP client across
   segment calls. Reduces TLS-handshake / TCP-setup overhead even on a
   plaintext local network.
2. **Retry on 503** with a 5-second back-off, once. Cold-start race.
3. **Sensible timeout** — 5 minutes hard cap per request. Streaming is
   different — see below.
4. **Validate `ref_voice`** against the cached `GET /v1/audio/voices`
   response before posting, so an LLM mis-typing `abhishek` fails fast
   client-side with a clear error.
5. **Concurrency cap** — default 3 in flight. The server is happiest with
   that; beyond 4 the GPU bandwidth saturates on a DGX Spark.
6. **Per-segment idempotence** — if `out_path` already exists and is
   non-empty, skip (so re-runs of a partial pipeline are cheap).
7. **Logging** — log segment id + voice + duration + wall time. Helpful
   when QA listens through.
8. **Optional streaming** — for the video generator's use-case
   (write-to-file), streaming is rarely worth it (it's the same total wall
   time, just chunks earlier). Implement only if you want progressive
   playback while generating.

### What the wrapper does NOT need to do

- No SDK install. Use whatever HTTP lib is already in the project.
- No auth handling. Tailscale handles network access.
- No retries on 4xx — that's a permanent client error; fail loudly.
- No CORS shenanigans — server-to-server, no browser involvement.

---

## 9. Streaming (only if needed)

Set `stream: true` and `response_format: "pcm"`. The server then returns
chunked raw 16-bit little-endian PCM at 24 kHz mono. First chunk lands in
~300–500 ms; rest follow as decoded. Useful for live voice agents; usually
overkill for offline video generation.

```bash
curl -sX POST http://100.111.8.126:8020/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"task_type":"Base","ref_voice":"Abhishek","input":"Streaming test.",
       "language":"English","stream":true,"response_format":"pcm"}' \
  --no-buffer | aplay -r 24000 -f S16_LE -c 1   # or pipe to sox / sounddevice
```

### Wrapping streamed PCM as WAV in code

```python
# Save the streamed chunks, then prepend a 44-byte WAV header.
import struct, httpx

def save_streamed_pcm_as_wav(text, voice, out_path):
    pcm = bytearray()
    with httpx.Client(timeout=None) as c:
        with c.stream("POST", "http://100.111.8.126:8020/v1/audio/speech",
                      json={"task_type":"Base","ref_voice":voice,
                            "input":text,"language":"English",
                            "stream":True,"response_format":"pcm"}) as r:
            r.raise_for_status()
            for chunk in r.iter_bytes():
                pcm.extend(chunk)

    n = len(pcm) & ~1
    sample_rate = 24000
    header = b"RIFF" + struct.pack("<I", 36 + n) + b"WAVEfmt " \
           + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate*2, 2, 16) \
           + b"data" + struct.pack("<I", n)
    open(out_path, "wb").write(header + bytes(pcm[:n]))
```

---

## 10. Diagnostics — verify the service before generating 500 WAVs

```bash
# Health
curl -s http://100.111.8.126:8020/health

# Voices the server knows
curl -s http://100.111.8.126:8020/v1/audio/voices | jq '.uploaded_voices[].name'

# Single-shot speed test (warm)
time curl -sf -X POST http://100.111.8.126:8020/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"task_type":"Base","ref_voice":"Abhishek","input":"Latency test.","language":"English"}' \
  --output /tmp/perf.wav
```

Healthy single-shot: ~1 s total wall time for a short sentence. If you see
`status: "degraded"` from `/health` but `base: "up"`, that's fine for our
use-case (other backends are intentionally offline).

---

## 11. Cheat-sheet for the wrapper builder

```
HOST           http://100.111.8.126:8020
METHOD         POST
PATH           /v1/audio/speech
HEADERS        Content-Type: application/json
BODY (min)     {"task_type":"Base","ref_voice":"Abhishek","input":"…","language":"English"}
RESPONSE       audio/wav binary body, HTTP 200
VOICES         "Abhishek"   "Hari"    (case-sensitive)
LANGUAGES      Auto, English, Chinese, Japanese, Korean, German, French,
               Russian, Portuguese, Spanish, Italian
FORMATS        wav (default), mp3, flac, pcm, aac, opus
STYLE HOOK     {"instructions":"with excitement"}   (any short natural-language phrase)
TIMEOUT        300 s (cold start) / 30 s (warm) — pick 300 to be safe
RETRY POLICY   503 → wait 5 s, retry once. 4xx → fail loudly.
CONCURRENCY    Cap at 3 in flight for best throughput
COST MODEL     Free — single self-hosted DGX, no per-request charge
```

### One last call-out

The model **does not translate**. `input` is spoken character-for-character.
Set `language` to match the language of `input`. If your video script is
multilingual, split it into segments and call once per language.

Good luck — build the wrapper that's right for the host language / framework
and you're done.
