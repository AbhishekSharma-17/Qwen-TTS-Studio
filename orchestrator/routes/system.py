from __future__ import annotations

import time

from fastapi import APIRouter, Request

from ..schemas import HealthPayload, InfoPayload

router = APIRouter()

SUPPORTED_LANGUAGES = [
    "Auto", "Chinese", "English", "Japanese", "Korean", "German",
    "French", "Russian", "Portuguese", "Spanish", "Italian",
]

RESPONSE_FORMATS = ["wav", "mp3", "flac", "pcm", "aac", "opus"]


@router.get("/health", response_model=HealthPayload)
async def health(request: Request) -> HealthPayload:
    reg = request.app.state.backends
    started = request.app.state.started_at
    return HealthPayload(
        status=reg.aggregate_status(),
        backends={tt.lower(): b.status for tt, b in reg.backends.items()},
        uptime_s=int(time.time() - started),
    )


@router.get("/info", response_model=InfoPayload)
async def info(request: Request) -> InfoPayload:
    reg = request.app.state.backends
    models = {
        tt: {
            "model_path": b.model_path,
            "url": b.url,
            "status": b.status,
            "builtin_voices": b.builtin_voices,
            "last_error": b.last_error,
        }
        for tt, b in reg.backends.items()
    }
    return InfoPayload(
        models=models,
        languages=SUPPORTED_LANGUAGES,
        response_formats=RESPONSE_FORMATS,
        features={
            "streaming_pcm": True,
            "websocket_text_stream": True,
            "voice_cloning": True,
            "voice_design": True,
            "multilingual": True,
        },
    )


@router.get("/v1/tts/languages")
async def languages() -> dict:
    return {"languages": SUPPORTED_LANGUAGES}


@router.get("/v1/tts/tasks")
async def tasks(request: Request) -> dict:
    """UI helper: task catalogue with per-speaker description strings."""
    reg = request.app.state.backends
    return {
        "tasks": [
            {
                "task_type": "CustomVoice",
                "description": "9 preset speakers with optional tone/emotion instruction.",
                "backend_status": reg["CustomVoice"].status,
                "speakers": [
                    {"name": "vivian", "desc": "Bright, slightly edgy young female voice.", "native": "Chinese"},
                    {"name": "serena", "desc": "Warm, gentle young female voice.", "native": "Chinese"},
                    {"name": "uncle_fu", "desc": "Seasoned male, low mellow timbre.", "native": "Chinese"},
                    {"name": "dylan", "desc": "Youthful Beijing male, clear natural timbre.", "native": "Chinese (Beijing)"},
                    {"name": "eric", "desc": "Lively Chengdu male, slightly husky brightness.", "native": "Chinese (Sichuan)"},
                    {"name": "ryan", "desc": "Dynamic male voice with strong rhythmic drive.", "native": "English"},
                    {"name": "aiden", "desc": "Sunny American male with clear midrange.", "native": "English"},
                    {"name": "ono_anna", "desc": "Playful Japanese female, light nimble timbre.", "native": "Japanese"},
                    {"name": "sohee", "desc": "Warm Korean female, rich emotion.", "native": "Korean"},
                ],
                "instruction_examples": [
                    "Speak with a British accent",
                    "Speak excitedly",
                    "Speak slowly and professionally",
                    "Whisper, as if telling a secret",
                ],
            },
            {
                "task_type": "VoiceDesign",
                "description": "Describe a voice in natural language; the model designs it.",
                "backend_status": reg["VoiceDesign"].status,
                "instruction_examples": [
                    "a warm elderly male narrator with a slow, reassuring pace",
                    "an energetic young female podcast host",
                    "a gravelly, weary detective in his sixties",
                    "a crisp neutral newsreader",
                ],
            },
            {
                "task_type": "Base",
                "description": "Voice cloning from 3–15 s reference audio (plus transcript for best quality).",
                "backend_status": reg["Base"].status,
                "tips": [
                    "Include the exact transcript of the reference clip for in-context cloning.",
                    "Use 3–15 s of clean speech, ideally a single speaker, no background music.",
                ],
            },
        ]
    }
