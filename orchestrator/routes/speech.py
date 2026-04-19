from __future__ import annotations

import base64
import logging
import mimetypes
from pathlib import Path
from typing import Any

import aiofiles
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from ..audio import response_mime
from ..schemas import SpeechRequest

logger = logging.getLogger("orchestrator.routes.speech")

router = APIRouter()


async def _encode_ref_from_library(request: Request, ref_voice: str) -> tuple[str, str | None]:
    """Resolve a saved voice name → (base64 data URL, ref_text)."""
    lib = request.app.state.voice_library
    ref = lib.get(ref_voice)
    if ref is None:
        raise HTTPException(
            status_code=404,
            detail=f"ref_voice '{ref_voice}' not found in voice library",
        )
    async with aiofiles.open(ref.file_path, "rb") as f:
        content = await f.read()
    mime = ref.mime_type or mimetypes.guess_type(ref.file_path)[0] or "audio/wav"
    data_url = f"data:{mime};base64,{base64.b64encode(content).decode('ascii')}"
    return data_url, ref.ref_text


def _build_backend_payload(req: SpeechRequest) -> dict[str, Any]:
    """Translate our request into the shape the vLLM-Omni backend expects."""
    payload: dict[str, Any] = {
        "input": req.input,
        "response_format": req.response_format,
        "task_type": req.task_type,
        "language": req.language,
        "stream": req.stream,
    }
    if req.voice:
        payload["voice"] = req.voice
    if req.model:
        payload["model"] = req.model
    if req.instructions:
        payload["instructions"] = req.instructions
    if req.max_new_tokens:
        payload["max_new_tokens"] = req.max_new_tokens
    if req.initial_codec_chunk_frames is not None:
        payload["initial_codec_chunk_frames"] = req.initial_codec_chunk_frames
    if req.speed != 1.0 and not req.stream:
        payload["speed"] = req.speed
    if req.task_type == "Base":
        if req.ref_audio:
            payload["ref_audio"] = req.ref_audio
        if req.ref_text:
            payload["ref_text"] = req.ref_text
        if req.x_vector_only_mode is not None:
            payload["x_vector_only_mode"] = req.x_vector_only_mode
    return payload


@router.post("/v1/audio/speech")
async def create_speech(request: Request, body: SpeechRequest):
    settings = request.app.state.settings
    reg = request.app.state.backends
    client = request.app.state.http_client

    # Library-voice resolution
    if body.task_type == "Base" and body.ref_voice and not body.ref_audio:
        data_url, auto_ref_text = await _encode_ref_from_library(request, body.ref_voice)
        body.ref_audio = data_url
        if not body.ref_text and auto_ref_text:
            body.ref_text = auto_ref_text

    # Task-specific validation
    if body.task_type == "CustomVoice" and not body.voice:
        body.voice = "vivian"
    if body.task_type == "VoiceDesign" and not body.instructions:
        raise HTTPException(
            status_code=400,
            detail="VoiceDesign task requires 'instructions' describing the voice",
        )
    if body.task_type == "Base" and not body.ref_audio:
        raise HTTPException(
            status_code=400,
            detail="Base task requires 'ref_audio' (file URL, data URL) or 'ref_voice' (library name)",
        )
    if body.stream and body.response_format != "pcm":
        raise HTTPException(
            status_code=400,
            detail="stream=true requires response_format='pcm'",
        )

    backend = reg[body.task_type]
    if backend.status != "up":
        raise HTTPException(
            status_code=503,
            detail=f"{body.task_type} backend is {backend.status}: {backend.last_error}",
        )

    payload = _build_backend_payload(body)
    url = f"{backend.url}/v1/audio/speech"

    mime = response_mime(body.response_format)
    timeout = 300.0

    if body.stream:
        async def body_stream():
            async with client.stream("POST", url, json=payload, timeout=timeout) as r:
                if r.status_code != 200:
                    detail = await r.aread()
                    raise HTTPException(
                        status_code=r.status_code,
                        detail=f"backend error: {detail.decode(errors='replace')[:500]}",
                    )
                async for chunk in r.aiter_bytes():
                    yield chunk

        return StreamingResponse(
            body_stream(),
            media_type=mime,
            headers={
                "Cache-Control": "no-store",
                "X-Qwentts-Task": body.task_type,
                "X-Qwentts-Format": body.response_format,
                "X-Qwentts-SampleRate": str(settings.default_sample_rate),
            },
        )

    r = await client.post(url, json=payload, timeout=timeout)
    if r.status_code != 200:
        raise HTTPException(
            status_code=r.status_code,
            detail=f"backend error: {r.text[:500]}",
        )
    return Response(
        content=r.content,
        media_type=mime,
        headers={
            "Cache-Control": "no-store",
            "X-Qwentts-Task": body.task_type,
            "X-Qwentts-Format": body.response_format,
        },
    )
