from __future__ import annotations

import logging
from typing import Optional

import aiofiles
from fastapi import APIRouter, File, Form, HTTPException, Path, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from ..schemas import VoicesList

logger = logging.getLogger("orchestrator.routes.voices")

router = APIRouter()

MAX_UPLOAD_BYTES_DEFAULT = 10 * 1024 * 1024  # 10 MB


@router.get("/v1/audio/voices", response_model=VoicesList)
async def list_voices(request: Request) -> VoicesList:
    reg = request.app.state.backends
    lib = request.app.state.voice_library

    builtin = reg.all_builtin_voices()
    uploaded = lib.list()
    all_names = sorted({
        *(v for lst in builtin.values() for v in lst),
        *(u.name for u in uploaded),
    })
    return VoicesList(
        voices=all_names,
        uploaded_voices=uploaded,
        builtin_by_task=builtin,
    )


@router.post("/v1/audio/voices")
async def upload_voice(
    request: Request,
    audio_sample: UploadFile = File(...),
    consent: str = Form(...),
    name: str = Form(...),
    ref_text: Optional[str] = Form(None),
    speaker_description: Optional[str] = Form(None),
    language: Optional[str] = Form(None),
):
    settings = request.app.state.settings
    lib = request.app.state.voice_library
    reg = request.app.state.backends
    client = request.app.state.http_client

    max_bytes = settings.max_upload_mb * 1024 * 1024
    content = await audio_sample.read()
    if len(content) > max_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"File too large: {len(content)} > {max_bytes} bytes",
        )
    if len(content) < 1024:
        raise HTTPException(
            status_code=400,
            detail="Reference audio is implausibly small (< 1 KB)",
        )

    try:
        ref = await lib.add(
            name=name,
            content=content,
            mime_type=audio_sample.content_type or "audio/wav",
            ref_text=ref_text,
            speaker_description=speaker_description,
            consent_id=consent,
            language=language,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    base_backend = reg["Base"]
    mirror_ok = False
    if base_backend.status == "up":
        mirror_ok = await lib.upload_to_base_backend(
            client, base_backend.url, ref
        )
    return JSONResponse(
        {
            "success": True,
            "voice": ref.model_dump(),
            "mirrored_to_base_backend": mirror_ok,
        }
    )


@router.delete("/v1/audio/voices/{name}")
async def delete_voice(request: Request, name: str = Path(...)):
    lib = request.app.state.voice_library
    ok = await lib.remove(name)
    if not ok:
        raise HTTPException(status_code=404, detail=f"voice '{name}' not found")
    return {"success": True, "name": name}


@router.get("/v1/audio/voices/{name}/preview")
async def preview_voice(request: Request, name: str = Path(...)):
    lib = request.app.state.voice_library
    ref = lib.get(name)
    if ref is None:
        raise HTTPException(status_code=404, detail=f"voice '{name}' not found")
    return FileResponse(
        ref.file_path,
        media_type=ref.mime_type,
        filename=f"{name}.wav",
    )
