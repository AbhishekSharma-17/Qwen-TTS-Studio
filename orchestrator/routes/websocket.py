"""Passthrough WebSocket for vLLM-Omni's /v1/audio/speech/stream."""
from __future__ import annotations

import asyncio
import json
import logging

import websockets
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger("orchestrator.routes.websocket")
router = APIRouter()

TASK_HEADER = "x-qwentts-task"


@router.websocket("/v1/audio/speech/stream")
async def stream_ws(ws: WebSocket):
    await ws.accept()

    # Client must send a session.config message first; we peek at task_type
    # to pick the right backend, then open an upstream WS and shuttle frames.
    first = await ws.receive_text()
    try:
        cfg = json.loads(first)
    except Exception:
        await ws.send_json({"type": "error", "message": "first frame must be JSON session.config"})
        await ws.close()
        return
    if cfg.get("type") != "session.config":
        await ws.send_json({"type": "error", "message": "expected session.config as first frame"})
        await ws.close()
        return

    task_type = cfg.get("task_type", "CustomVoice")
    reg = ws.app.state.backends
    backend = reg[task_type]
    if backend.status != "up":
        await ws.send_json({
            "type": "error",
            "message": f"{task_type} backend is {backend.status}",
        })
        await ws.close()
        return

    upstream_url = backend.url.replace("http://", "ws://") + "/v1/audio/speech/stream"

    try:
        async with websockets.connect(upstream_url, max_size=16 * 1024 * 1024) as upstream:
            await upstream.send(first)

            async def client_to_upstream() -> None:
                try:
                    while True:
                        msg = await ws.receive()
                        if msg.get("type") == "websocket.disconnect":
                            return
                        if "text" in msg and msg["text"] is not None:
                            await upstream.send(msg["text"])
                        elif "bytes" in msg and msg["bytes"] is not None:
                            await upstream.send(msg["bytes"])
                except WebSocketDisconnect:
                    return

            async def upstream_to_client() -> None:
                async for msg in upstream:
                    if isinstance(msg, (bytes, bytearray)):
                        await ws.send_bytes(bytes(msg))
                    else:
                        await ws.send_text(msg)

            await asyncio.gather(client_to_upstream(), upstream_to_client())
    except Exception as exc:  # noqa: BLE001
        logger.warning("websocket bridge error: %s", exc)
    finally:
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass
