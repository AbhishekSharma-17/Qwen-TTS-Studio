# Qwen3-TTS Studio — System Overview

**Production-grade, fully-local text-to-speech** built on Alibaba's
Qwen3-TTS-12Hz-1.7B model family, wrapped in an OpenAI-compatible HTTP API,
a browser UI, and a standalone single-model mode that drops into any
application. Runs entirely on an **NVIDIA DGX Spark** (GB10 Grace-Blackwell),
no cloud dependency, no data egress.

---

## Features

### User-facing capabilities

- **Nine studio-quality preset voices** — English, Chinese, Japanese, Korean,
  plus Beijing and Sichuan Chinese dialects. Optional natural-language
  instructions to shape tone, emotion, accent, and pace.
- **Voice design from a description** — type *"a warm elderly male narrator
  with a slow, reassuring pace"* and get a brand-new voice matching.
- **Voice cloning from 3–15 s of reference audio** — upload any clean clip,
  optionally include the transcript for in-context cloning (ICL mode),
  generate arbitrary text in that voice. Cross-lingual cloning works.
- **Persistent voice library** — saved voices survive restarts, are mirrored
  to the Base backend automatically, and are referenceable by name via
  `ref_voice: "my_narrator"`.
- **Eleven languages** — Chinese, English, Japanese, Korean, German, French,
  Russian, Portuguese, Spanish, Italian, plus `Auto` detection.
- **Real-time streaming** — sub-300 ms time-to-first-audio via chunked PCM
  over HTTP. Audio starts playing before the sentence finishes generating.
- **WebSocket text-in / audio-out** — `/v1/audio/speech/stream` endpoint for
  LLM→TTS pipelines where text arrives token-by-token.
- **Six output formats** — WAV, MP3, FLAC, PCM, AAC, Opus. Downloadable from
  the UI mid-stream; choose what fits your pipeline.
- **Browser UI** — light theme, sidebar navigation, live equaliser visualiser
  while audio plays, prominent stop & download controls, per-card progress
  bar, squarish chips with example prompts, keyboard-accessible custom
  dropdowns.
- **Load/unload individual models** — from the UI or via
  `POST /v1/admin/models/{task}/load`. Free GPU memory when a task type
  isn't needed; cold-start it back in 30–60 s.
- **Standalone single-model mode** — `bash scripts/run_customvoice.sh`
  launches one backend on its own port, zero dependencies on the UI or
  orchestrator. Perfect for embedding in other services.

### Developer-facing capabilities

- **OpenAI-compatible speech API** — any OpenAI SDK works with
  `base_url="http://.../v1"`. Zero-code-change migration from cloud TTS.
- **Endpoints at a glance**:
  - `POST /v1/audio/speech` — synthesise (blocking or streamed PCM)
  - `GET /v1/audio/voices` + `POST /v1/audio/voices` — list / upload
  - `DELETE /v1/audio/voices/{name}` / preview
  - `WS /v1/audio/speech/stream` — incremental text input
  - `GET /health`, `/info`, `/v1/tts/languages`, `/v1/tts/tasks`
  - `POST /v1/admin/models/{task}/load|unload`
- **Supervisord-managed** — auto-restart on crash, aggregated logs,
  per-process start/stop, XML-RPC control plane.

---

## Architecture

Four layers, one direction of flow:

```
  ┌───────────────────────────────────────────────┐
  │  Browser · single-page UI · light theme       │  ← vanilla HTML/CSS/JS, ES modules
  └──────────────────┬────────────────────────────┘
                     │  HTTP / WebSocket
                     ▼
  ┌───────────────────────────────────────────────┐
  │  FastAPI orchestrator  ·  port 8080           │
  │    · OpenAI-compatible /v1/audio/speech       │
  │    · Voice library (persistent, mirrored)     │
  │    · Admin API · WebSocket bridge             │
  └────┬─────────────────┬──────────────────┬─────┘
       │  by task_type   │                  │
       ▼                 ▼                  ▼
  ┌────────────┐   ┌────────────┐   ┌────────────┐
  │  vLLM-Omni │   │  vLLM-Omni │   │  vLLM-Omni │
  │  :8091     │   │  :8092     │   │  :8093     │
  │ CustomVoice│   │ VoiceDesign│   │    Base    │
  │            │   │            │   │ (clone)    │
  │  Talker    │   │  Talker    │   │  Talker    │  ← Qwen3-TTS-12Hz-1.7B
  │      ↓     │   │      ↓     │   │      ↓     │     (28-layer LM)
  │  Code2Wav  │   │  Code2Wav  │   │  Code2Wav  │  ← shared codec decoder
  └────────────┘   └────────────┘   └────────────┘
               Supervisord watches all four processes
  ─────────────────────────────────────────────────
  NVIDIA DGX Spark  ·  GB10 Grace-Blackwell
  128 GB LPDDR5x  ·  CUDA 13  ·  FlashAttention 2 (sm_120)
```

- **One vLLM-Omni process per task** — vLLM binds one model per instance.
  Running all three concurrently = instant task switch with no cold start.
- **Two-stage pipeline per backend** — Stage 0 (Talker, autoregressive LM,
  CUDA graphs) → shared-memory connector → Stage 1 (Code2Wav codec, eager
  mode). Async-chunk streaming between stages means first audio packet
  arrives before the LM finishes decoding.
- **Total GPU memory at idle** — ~20 GB of 128 GB with all three models
  resident. Room for ~6 concurrent streams before bandwidth saturates.

---

## Technical highlights

- **Model family**: [Qwen3-TTS-12Hz-1.7B](https://huggingface.co/collections/Qwen/qwen3-tts)
  — 1.7 B-parameter Talker + 170 M-param Code2Wav codec. 12.5 Hz frame rate,
  16-codebook SplitRVQ (1 semantic + 15 acoustic), 24 kHz output, fully causal
  conv decoder (no diffusion, no flow-matching — sub-100 ms TTFA by design).
- **Inference engine**: [vLLM-Omni 0.19+](https://github.com/vllm-project/vllm-omni)
  on vLLM 0.19.1 aarch64+cu130. Patched to remove Hopper-only `fa3-fwd`.
  CUDA Graph + `torch.compile` on the Talker's decode loop.
- **Attention**: FlashAttention 2.8.3 compiled from source for
  `sm_120` only — cuts build time 4× by skipping unused arch targets.
- **Hardware optimisation** — GB10 is 128 GB LPDDR5x @ 273 GB/s. Three
  bf16 models coexist comfortably. Per-stage `gpu_memory_utilization: 0.15`
  leaves headroom for KV caches and an OS display.
- **Process supervision** — Supervisord with XML-RPC control plane; the
  orchestrator's `SupervisorClient` talks to it over a Unix socket so the
  admin API can load/unload backends live without touching shell scripts.
- **Voice library self-healing** — uploaded reference voices are stored on
  disk (`data/voices/` + `voices.json`) and replayed to the Base backend on
  every startup. Crash-safe even if a vLLM worker goes down mid-session.
- **Streaming audio pipeline** — chunked-transfer PCM over HTTP, 24 kHz /
  16-bit / mono. Browser side: gapless `AudioContext.createBufferSource()`
  scheduling, odd-byte alignment handling between fetch chunks, `AbortController`-
  based stop, partial-WAV download even from aborted streams.
- **UI** — vanilla HTML/CSS/JS, no framework, no build step. Custom `<select>`
  → styled dropdown component with full keyboard navigation (↑/↓, Enter, Home,
  End, typeahead, Esc, outside-click), ARIA combobox/listbox roles, dynamic
  option re-rendering via `MutationObserver`.
- **Playback animations** — CSS-only 5-bar equaliser + card-pulse keyframes;
  `PcmStreamPlayer.onPlaybackEnd` fires when the WebAudio buffer queue drains,
  keeping the "now playing" state tied to actual audio output (not just data
  arrival). Everything wrapped in `@media (prefers-reduced-motion)`.
- **OpenAI API parity** — every field in the spec is passed through; extra
  Qwen3-TTS fields (`task_type`, `instructions`, `ref_audio`, `ref_text`,
  `ref_voice`, `stream`, `x_vector_only_mode`, `max_new_tokens`,
  `initial_codec_chunk_frames`) are additive.
- **Benchmark numbers** (GB10, single-user):

  | Task | TTFA | Total (50 char input) |
  |---|---|---|
  | Preset voice (CustomVoice) | < 250 ms | ~1.0 s |
  | Voice design | < 350 ms | ~1.2 s |
  | Voice clone (Base, 8 s ref) | < 700 ms | ~1.8 s |

---

## Benefits

**For the operator**

- **Fully local.** No audio ever leaves the DGX Spark. Not for training, not
  for inference, not for analytics. GDPR/HIPAA/internal-security friendly
  by default.
- **Production-ready.** Supervisor auto-restarts, health probes every 10 s,
  per-backend status tracking, graceful shutdown, self-healing voice
  library. Built to stay up.
- **One-machine economics.** Runs on a single NVIDIA DGX Spark
  (≈ $3,999 street price in 2026). No per-request API cost, no rate
  limits, no quotas, no surprise bills.
- **Standard tooling.** OpenAI SDK works unchanged. Drop-in replacement
  for cloud TTS in any existing app.
- **Fast enough for real-time interfaces.** Sub-300 ms TTFA with streaming
  means voice assistants, live captioning, and conversational agents feel
  responsive.

**For the integrator**

- **Three integration levels** — full stack with UI (`:8080`), full stack
  programmatic (same port, no UI), standalone single-model (`:8091 / 8092 /
  8093`). Pick the smallest surface that fits your use case.
- **Zero framework lock-in** — FastAPI backend is ~500 LOC of Python, UI is
  plain HTML/CSS/JS, models are HuggingFace-standard checkpoints. Anything
  can be replaced piecemeal.
- **Persistent voice identities** — upload once, reference by name
  forever. Essential for chapter-by-chapter audiobook narration, branded
  voice assistants, personalisation.
- **Multiple creative modes** — preset for consistency, design for
  creative freedom, clone for specific identity. Cover the full spectrum
  of TTS use-cases without juggling vendors.

**For the end-user**

- **Low latency, natural voices** — tuned for interactive UX.
- **11 languages** — out of the box, one speaker can speak any of them.
- **Cross-lingual voice cloning** — your own voice, in Chinese or Japanese,
  with no additional training.

---

## Stack summary

| Layer | Technology |
|---|---|
| Hardware | NVIDIA DGX Spark · GB10 Grace-Blackwell · 128 GB LPDDR5x · aarch64 |
| CUDA / drivers | CUDA 13.0 · driver 580+ · FlashAttention 2.8.3 (sm_120) |
| Inference | PyTorch 2.10 · vLLM 0.19.1 · vLLM-Omni (main) · Transformers 5.5 |
| Models | Qwen3-TTS-12Hz-1.7B Base / CustomVoice / VoiceDesign + Tokenizer-12Hz (shared codec) |
| Orchestrator | FastAPI 0.136 · uvicorn 0.44 · httpx 0.28 · pydantic 2.13 |
| UI | Vanilla HTML/CSS/JS, ES modules (Inter + JetBrains Mono) |
| Process management | Supervisord 4.2 · XML-RPC admin control |
| Audio | soundfile · librosa · resampy · torchaudio · pydub |

---

## See also

- [`README.md`](../README.md) — one-page quick start and API cheat-sheet
- [`GUIDE.md`](GUIDE.md) — the full 18-section operator guide (installation,
  commands, features, API reference, integration, use-case recipes,
  troubleshooting, architecture deep-dive)
- [`GUIDE.pdf`](GUIDE.pdf) — PDF version of the above
