"""Backend registry and health tracking for the 3 vLLM-Omni servers."""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Optional

import httpx

from .config import Settings

logger = logging.getLogger("orchestrator.backends")


@dataclass
class Backend:
    name: str
    task_type: str
    url: str
    model_path: str
    supervisor_program: str
    status: str = "starting"       # up / down / starting / stopped / fatal
    supervisor_state: str = "UNKNOWN"
    last_check: float = 0.0
    last_error: Optional[str] = None
    builtin_voices: list[str] = field(default_factory=list)


class BackendRegistry:
    def __init__(self, settings: Settings, client: httpx.AsyncClient):
        self.settings = settings
        self.client = client
        self.supervisor = None  # set in .start() — avoids import cycle
        self.backends: dict[str, Backend] = {
            "CustomVoice": Backend(
                name="customvoice",
                task_type="CustomVoice",
                url=f"http://{settings.customvoice_host}:{settings.customvoice_port}",
                model_path=str(settings.models_dir / "Qwen3-TTS-12Hz-1.7B-CustomVoice"),
                supervisor_program="vllm_customvoice",
            ),
            "VoiceDesign": Backend(
                name="voicedesign",
                task_type="VoiceDesign",
                url=f"http://{settings.voicedesign_host}:{settings.voicedesign_port}",
                model_path=str(settings.models_dir / "Qwen3-TTS-12Hz-1.7B-VoiceDesign"),
                supervisor_program="vllm_voicedesign",
            ),
            "Base": Backend(
                name="base",
                task_type="Base",
                url=f"http://{settings.base_host}:{settings.base_port}",
                model_path=str(settings.models_dir / "Qwen3-TTS-12Hz-1.7B-Base"),
                supervisor_program="vllm_base",
            ),
        }
        self._probe_task: Optional[asyncio.Task] = None

    def __getitem__(self, task_type: str) -> Backend:
        return self.backends[task_type]

    async def probe_once(self, backend: Backend) -> None:
        # 1. Ask supervisord for process state first.
        sup_state = "UNKNOWN"
        if self.supervisor is not None:
            try:
                info = await self.supervisor.get_process_info(backend.supervisor_program)
                sup_state = info.get("statename", "UNKNOWN")
                backend.supervisor_state = sup_state
            except Exception as exc:  # noqa: BLE001
                logger.debug("supervisor probe failed for %s: %s", backend.name, exc)

        # 2. HTTP probe only makes sense if supervisord thinks it's running.
        if sup_state in ("STOPPED", "EXITED", "STOPPING", "BACKOFF"):
            backend.status = "stopped" if sup_state == "STOPPED" else "down"
            backend.last_error = None if sup_state == "STOPPED" else f"supervisor={sup_state}"
            backend.builtin_voices = []
            backend.last_check = time.time()
            return
        if sup_state == "FATAL":
            backend.status = "fatal"
            backend.last_error = "supervisor gave up restarting — check logs"
            backend.builtin_voices = []
            backend.last_check = time.time()
            return
        if sup_state == "STARTING":
            backend.status = "starting"
            # still try HTTP probe below — may already be accepting connections
        try:
            r = await self.client.get(f"{backend.url}/v1/audio/voices", timeout=3.0)
            if r.status_code == 200:
                data = r.json()
                backend.builtin_voices = list(data.get("voices", []))
                backend.status = "up"
                backend.last_error = None
            else:
                backend.status = "down" if sup_state != "STARTING" else "starting"
                backend.last_error = f"HTTP {r.status_code}"
        except Exception as exc:  # noqa: BLE001
            backend.status = "starting" if sup_state == "STARTING" else "down"
            backend.last_error = str(exc)
        backend.last_check = time.time()

    async def probe_all(self) -> None:
        await asyncio.gather(*(self.probe_once(b) for b in self.backends.values()))

    async def run_probe_loop(self, interval_s: float = 10.0) -> None:
        while True:
            try:
                await self.probe_all()
            except Exception as exc:  # noqa: BLE001
                logger.warning("probe loop error: %s", exc)
            await asyncio.sleep(interval_s)

    async def start(self) -> None:
        await self.probe_all()
        self._probe_task = asyncio.create_task(self.run_probe_loop())

    async def stop(self) -> None:
        if self._probe_task is not None:
            self._probe_task.cancel()
            try:
                await self._probe_task
            except asyncio.CancelledError:
                pass

    def aggregate_status(self) -> str:
        statuses = [b.status for b in self.backends.values()]
        # "stopped" backends are intentionally offline — don't count against health.
        live = [s for s in statuses if s != "stopped"]
        if not live:
            return "idle"
        if all(s == "up" for s in live):
            return "healthy"
        if any(s == "up" for s in live):
            return "degraded"
        return "unhealthy"

    def all_builtin_voices(self) -> dict[str, list[str]]:
        return {tt: b.builtin_voices for tt, b in self.backends.items()}
