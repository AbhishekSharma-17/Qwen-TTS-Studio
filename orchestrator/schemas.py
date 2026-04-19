from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

TaskType = Literal["CustomVoice", "VoiceDesign", "Base"]
Language = Literal[
    "Auto", "Chinese", "English", "Japanese", "Korean", "German",
    "French", "Russian", "Portuguese", "Spanish", "Italian",
]
ResponseFormat = Literal["wav", "mp3", "flac", "pcm", "aac", "opus"]


class SpeechRequest(BaseModel):
    """Accepted by POST /v1/audio/speech.

    Superset of OpenAI's audio.speech schema, plus Qwen3-TTS extensions and
    a `ref_voice` convenience field that resolves against our voice library.
    """

    input: str = Field(..., min_length=1, max_length=8000)
    voice: Optional[str] = None
    model: Optional[str] = None
    response_format: ResponseFormat = "wav"
    speed: float = Field(1.0, ge=0.25, le=4.0)

    task_type: TaskType = "CustomVoice"
    language: Language = "Auto"
    instructions: Optional[str] = None
    max_new_tokens: Optional[int] = Field(None, ge=32, le=8192)
    initial_codec_chunk_frames: Optional[int] = None
    stream: bool = False

    ref_audio: Optional[str] = None  # HTTP URL, data URL, or file:// URI
    ref_text: Optional[str] = None
    x_vector_only_mode: Optional[bool] = None
    ref_voice: Optional[str] = None  # name from our voice library


class VoiceRef(BaseModel):
    name: str
    mime_type: str
    file_path: str
    file_size: int
    created_at: int
    consent_id: Optional[str] = None
    ref_text: Optional[str] = None
    speaker_description: Optional[str] = None
    language: Optional[str] = None


class VoicesList(BaseModel):
    voices: list[str]
    uploaded_voices: list[VoiceRef] = []
    builtin_by_task: dict[str, list[str]] = {}


class HealthPayload(BaseModel):
    status: Literal["healthy", "degraded", "unhealthy", "idle"]
    backends: dict[str, Literal["up", "down", "starting", "stopped", "fatal"]]
    uptime_s: int


class InfoPayload(BaseModel):
    name: str = "Qwen3-TTS Studio"
    version: str = "0.1.0"
    models: dict[str, dict]
    languages: list[str]
    response_formats: list[str]
    features: dict[str, bool]
