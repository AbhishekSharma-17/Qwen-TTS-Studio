"""Admin routes for per-model load / unload."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Path, Request

logger = logging.getLogger("orchestrator.routes.models")

router = APIRouter()

VALID_TASKS = {"CustomVoice", "VoiceDesign", "Base"}


def _model_summary(backend) -> dict[str, Any]:
    return {
        "task_type": backend.task_type,
        "supervisor_program": backend.supervisor_program,
        "model_path": backend.model_path,
        "url": backend.url,
        "status": backend.status,
        "supervisor_state": backend.supervisor_state,
        "builtin_voices": backend.builtin_voices,
        "last_error": backend.last_error,
        # approx weight size — purely informational
        "size_gb": 4.3,
    }


@router.get("/v1/admin/models")
async def list_models(request: Request) -> dict[str, Any]:
    reg = request.app.state.backends
    # Opportunistic probe so callers get fresh state.
    await reg.probe_all()
    return {
        "aggregate_status": reg.aggregate_status(),
        "models": [_model_summary(reg[t]) for t in ("CustomVoice", "VoiceDesign", "Base")],
    }


@router.get("/v1/admin/models/{task_type}")
async def get_model(request: Request, task_type: str = Path(...)) -> dict[str, Any]:
    if task_type not in VALID_TASKS:
        raise HTTPException(404, f"unknown task_type '{task_type}'")
    reg = request.app.state.backends
    await reg.probe_once(reg[task_type])
    return _model_summary(reg[task_type])


async def _wait_until(
    reg, task_type: str, target: set[str], timeout_s: float = 180.0
) -> str:
    """Poll the backend's status until it matches any of `target` or timeout."""
    deadline = time.time() + timeout_s
    last = ""
    while time.time() < deadline:
        await reg.probe_once(reg[task_type])
        last = reg[task_type].status
        if last in target:
            return last
        await asyncio.sleep(2.0)
    return last


@router.post("/v1/admin/models/{task_type}/load")
async def load_model(
    request: Request,
    task_type: str = Path(...),
    wait: bool = True,
) -> dict[str, Any]:
    if task_type not in VALID_TASKS:
        raise HTTPException(404, f"unknown task_type '{task_type}'")
    reg = request.app.state.backends
    supervisor = request.app.state.supervisor
    backend = reg[task_type]

    # Start via supervisord. `wait=False` returns quickly; we do our own
    # readiness-wait on the HTTP probe.
    try:
        await supervisor.start(backend.supervisor_program, wait=False)
    except Exception as exc:  # noqa: BLE001
        logger.exception("failed to start %s", backend.supervisor_program)
        raise HTTPException(500, f"supervisor.start failed: {exc}") from exc

    if not wait:
        await reg.probe_once(backend)
        return {"success": True, "status": backend.status, "model": _model_summary(backend)}

    status = await _wait_until(reg, task_type, {"up"}, timeout_s=180.0)
    if status != "up":
        return {
            "success": False,
            "status": status,
            "error": backend.last_error or f"did not reach 'up' within timeout (last={status})",
            "model": _model_summary(backend),
        }
    return {"success": True, "status": status, "model": _model_summary(backend)}


@router.post("/v1/admin/models/{task_type}/unload")
async def unload_model(
    request: Request,
    task_type: str = Path(...),
    wait: bool = True,
) -> dict[str, Any]:
    if task_type not in VALID_TASKS:
        raise HTTPException(404, f"unknown task_type '{task_type}'")
    reg = request.app.state.backends
    supervisor = request.app.state.supervisor
    backend = reg[task_type]

    try:
        await supervisor.stop(backend.supervisor_program, wait=wait)
    except Exception as exc:  # noqa: BLE001
        logger.exception("failed to stop %s", backend.supervisor_program)
        raise HTTPException(500, f"supervisor.stop failed: {exc}") from exc

    if wait:
        await _wait_until(reg, task_type, {"stopped", "down"}, timeout_s=60.0)
    else:
        await reg.probe_once(backend)
    return {"success": True, "status": backend.status, "model": _model_summary(backend)}


@router.post("/v1/admin/models/all/load")
async def load_all(request: Request) -> dict[str, Any]:
    """Start every model. Returns once all are 'up' (or after per-model timeout)."""
    reg = request.app.state.backends
    supervisor = request.app.state.supervisor

    # Kick off all starts concurrently so they can compile in parallel
    # (they'll still serialise on the GPU, but that's fine).
    await asyncio.gather(*(
        supervisor.start(reg[t].supervisor_program, wait=False) for t in VALID_TASKS
    ))
    results = {}
    for t in VALID_TASKS:
        status = await _wait_until(reg, t, {"up"}, timeout_s=240.0)
        results[t] = {"status": status, "model": _model_summary(reg[t])}
    return {"success": all(r["status"] == "up" for r in results.values()), "models": results}


@router.post("/v1/admin/models/all/unload")
async def unload_all(request: Request) -> dict[str, Any]:
    """Stop every model — frees all GPU memory held by vLLM backends."""
    reg = request.app.state.backends
    supervisor = request.app.state.supervisor
    await asyncio.gather(*(
        supervisor.stop(reg[t].supervisor_program, wait=True) for t in VALID_TASKS
    ))
    await reg.probe_all()
    return {
        "success": True,
        "models": {t: _model_summary(reg[t]) for t in VALID_TASKS},
    }
