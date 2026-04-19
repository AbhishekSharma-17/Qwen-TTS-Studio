from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .backends import BackendRegistry
from .config import get_settings
from .routes import models as models_routes
from .routes import speech as speech_routes
from .routes import system as system_routes
from .routes import voices as voices_routes
from .routes import websocket as websocket_routes
from .supervisor_client import SupervisorClient
from .voice_library import VoiceLibrary

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger("orchestrator")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    app.state.settings = settings
    app.state.started_at = time.time()

    client = httpx.AsyncClient(timeout=None, http2=False)
    app.state.http_client = client

    sup_sock = settings.logs_dir / "supervisor.sock"
    supervisor = SupervisorClient(sup_sock)
    app.state.supervisor = supervisor

    registry = BackendRegistry(settings, client)
    registry.supervisor = supervisor
    app.state.backends = registry
    await registry.start()

    library = VoiceLibrary(settings)
    await library.load()
    app.state.voice_library = library

    base_backend = registry["Base"]
    if base_backend.status == "up" and library.list():
        count = await library.replay_to_base_backend(client, base_backend.url)
        logger.info("replayed %d cloned voices to Base backend", count)

    logger.info("orchestrator ready at %s:%s", settings.orch_host, settings.orch_port)
    try:
        yield
    finally:
        await registry.stop()
        await client.aclose()


app = FastAPI(
    title="Qwen3-TTS Studio",
    version="0.1.0",
    description=(
        "FastAPI orchestrator in front of three vLLM-Omni Qwen3-TTS backends "
        "(CustomVoice, VoiceDesign, Base). OpenAI-compatible speech API plus "
        "voice-library persistence."
    ),
    lifespan=lifespan,
)

app.include_router(system_routes.router, tags=["system"])
app.include_router(voices_routes.router, tags=["voices"])
app.include_router(speech_routes.router, tags=["speech"])
app.include_router(websocket_routes.router, tags=["speech"])
app.include_router(models_routes.router, tags=["models"])


# ------------- Static UI -------------
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
app.mount(
    "/static",
    StaticFiles(directory=str(STATIC_DIR), check_dir=True),
    name="static",
)


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    fav = STATIC_DIR / "assets" / "favicon.ico"
    if fav.exists():
        return FileResponse(str(fav))
    return FileResponse(str(STATIC_DIR / "assets" / "logo.svg"), media_type="image/svg+xml")
