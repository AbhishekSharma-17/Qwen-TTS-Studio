"""On-disk catalogue of user-uploaded reference voices.

The Base backend stores uploads in memory only; this layer persists them to
disk and can replay uploads to a freshly-started Base backend so cloned
voices survive restarts.
"""
from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import time
from pathlib import Path
from typing import Optional

import aiofiles
import httpx

from .config import Settings
from .schemas import VoiceRef

logger = logging.getLogger("orchestrator.voice_library")


class VoiceLibrary:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.voices_dir: Path = settings.voices_dir
        self.voices_json: Path = settings.voices_json
        self._lock = asyncio.Lock()
        self._cache: dict[str, VoiceRef] = {}
        self.voices_dir.mkdir(parents=True, exist_ok=True)

    async def load(self) -> None:
        if not self.voices_json.exists():
            self._cache = {}
            await self._persist()
            return
        async with aiofiles.open(self.voices_json, "r") as f:
            raw = await f.read()
        try:
            data = json.loads(raw)
            self._cache = {
                v["name"]: VoiceRef(**v) for v in data.get("voices", [])
            }
        except Exception as exc:  # noqa: BLE001
            logger.warning("voices.json is corrupt (%s); resetting", exc)
            self._cache = {}
            await self._persist()

    async def _persist(self) -> None:
        data = {"voices": [v.model_dump() for v in self._cache.values()]}
        async with aiofiles.open(self.voices_json, "w") as f:
            await f.write(json.dumps(data, indent=2, ensure_ascii=False))

    def list(self) -> list[VoiceRef]:
        return list(self._cache.values())

    def get(self, name: str) -> Optional[VoiceRef]:
        return self._cache.get(name)

    async def add(
        self,
        name: str,
        content: bytes,
        mime_type: str,
        *,
        ref_text: Optional[str] = None,
        speaker_description: Optional[str] = None,
        consent_id: Optional[str] = None,
        language: Optional[str] = None,
    ) -> VoiceRef:
        name = name.strip()
        if not name or "/" in name or ".." in name:
            raise ValueError("Invalid voice name")

        async with self._lock:
            ext = mimetypes.guess_extension(mime_type) or ".wav"
            target = self.voices_dir / f"{name}{ext}"
            async with aiofiles.open(target, "wb") as f:
                await f.write(content)
            ref = VoiceRef(
                name=name,
                mime_type=mime_type,
                file_path=str(target),
                file_size=len(content),
                created_at=int(time.time()),
                consent_id=consent_id,
                ref_text=ref_text,
                speaker_description=speaker_description,
                language=language,
            )
            self._cache[name] = ref
            await self._persist()
            return ref

    async def remove(self, name: str) -> bool:
        async with self._lock:
            ref = self._cache.pop(name, None)
            if ref is None:
                return False
            try:
                Path(ref.file_path).unlink(missing_ok=True)
            except Exception as exc:  # noqa: BLE001
                logger.warning("failed to unlink %s: %s", ref.file_path, exc)
            await self._persist()
            return True

    # -------------------- Base-backend mirroring --------------------

    async def upload_to_base_backend(
        self, client: httpx.AsyncClient, base_url: str, ref: VoiceRef
    ) -> bool:
        try:
            async with aiofiles.open(ref.file_path, "rb") as f:
                content = await f.read()
        except FileNotFoundError:
            logger.warning("missing ref audio on disk: %s", ref.file_path)
            return False

        files = {
            "audio_sample": (
                Path(ref.file_path).name,
                content,
                ref.mime_type,
            )
        }
        data = {
            "consent": ref.consent_id or f"orch-{ref.created_at}",
            "name": ref.name,
        }
        if ref.ref_text:
            data["ref_text"] = ref.ref_text
        if ref.speaker_description:
            data["speaker_description"] = ref.speaker_description

        try:
            r = await client.post(
                f"{base_url}/v1/audio/voices",
                data=data,
                files=files,
                timeout=60.0,
            )
            if r.status_code in (200, 201):
                return True
            logger.warning(
                "backend upload failed (%s): HTTP %s %s",
                ref.name,
                r.status_code,
                r.text[:200],
            )
            return False
        except Exception as exc:  # noqa: BLE001
            logger.warning("backend upload exception (%s): %s", ref.name, exc)
            return False

    async def replay_to_base_backend(
        self, client: httpx.AsyncClient, base_url: str
    ) -> int:
        count = 0
        for ref in self.list():
            if await self.upload_to_base_backend(client, base_url, ref):
                count += 1
        return count
