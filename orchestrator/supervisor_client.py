"""Thin async client that talks to the local supervisord over its
Unix-socket XML-RPC interface.

Supervisord exposes `getProcessInfo`, `startProcess`, `stopProcess` and
friends — these are what `supervisorctl` uses under the hood. We use
them directly so the orchestrator can manage the 3 vLLM-Omni programs
without shelling out to a binary.
"""
from __future__ import annotations

import asyncio
import http.client
import logging
import socket
import urllib.parse
import xmlrpc.client
from pathlib import Path
from typing import Any

logger = logging.getLogger("orchestrator.supervisor_client")


class _UnixSocketTransport(xmlrpc.client.Transport):
    """xmlrpc.client transport that speaks HTTP over a Unix socket."""

    def __init__(self, socket_path: str):
        super().__init__()
        self._socket_path = socket_path

    def make_connection(self, host: str) -> http.client.HTTPConnection:
        class _UnixHTTPConnection(http.client.HTTPConnection):
            def connect(self):  # type: ignore[override]
                self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                self.sock.connect(self._socket_path)  # set below

        conn = _UnixHTTPConnection("localhost")
        conn._socket_path = self._socket_path  # type: ignore[attr-defined]
        return conn


class SupervisorClient:
    """Async wrapper over supervisord's XML-RPC API.

    All the blocking xmlrpc calls are pushed to a thread pool so the
    FastAPI event loop stays responsive during a slow start/stop.
    """

    # Fault codes from supervisor/xmlrpc.py we handle gracefully
    ALREADY_STARTED = 60
    NOT_RUNNING = 70
    SPAWN_ERROR = 50
    ABNORMAL_TERMINATION = 40

    def __init__(self, socket_path: str | Path, group: str = "qwentts"):
        self.socket_path = str(socket_path)
        self.group = group
        self._proxy: xmlrpc.client.ServerProxy | None = None

    def _qualify(self, name: str) -> str:
        """Prepend the program group if the caller didn't already."""
        if ":" in name:
            return name
        return f"{self.group}:{name}"

    def _get_proxy(self) -> xmlrpc.client.ServerProxy:
        if self._proxy is None:
            transport = _UnixSocketTransport(self.socket_path)
            self._proxy = xmlrpc.client.ServerProxy(
                "http://localhost/RPC2", transport=transport, allow_none=True
            )
        return self._proxy

    async def _call(self, name: str, *args: Any) -> Any:
        def _do() -> Any:
            proxy = self._get_proxy()
            method_path = name.split(".")
            fn = proxy
            for part in method_path:
                fn = getattr(fn, part)
            return fn(*args)

        return await asyncio.to_thread(_do)

    async def get_process_info(self, name: str) -> dict[str, Any]:
        """Returns supervisord ProcessInfo dict. statename in
        STOPPED, STARTING, RUNNING, BACKOFF, STOPPING, EXITED, FATAL, UNKNOWN.
        """
        return await self._call("supervisor.getProcessInfo", self._qualify(name))

    async def start(self, name: str, wait: bool = False) -> bool:
        """Returns True if the program was (re)started. False if it was
        already running (we treat ALREADY_STARTED as idempotent success).
        """
        try:
            return await self._call("supervisor.startProcess", self._qualify(name), wait)
        except xmlrpc.client.Fault as fault:
            if fault.faultCode == self.ALREADY_STARTED:
                return True
            raise

    async def stop(self, name: str, wait: bool = True) -> bool:
        try:
            return await self._call("supervisor.stopProcess", self._qualify(name), wait)
        except xmlrpc.client.Fault as fault:
            if fault.faultCode == self.NOT_RUNNING:
                return True
            raise

    async def all_info(self) -> list[dict[str, Any]]:
        return await self._call("supervisor.getAllProcessInfo")
