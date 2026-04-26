import json
import time
from collections import deque
from threading import Lock

from fastapi import WebSocket, WebSocketDisconnect
from src.web.serialization import safe_jsonable


class WSHub:
    def __init__(self):
        self.active: set[WebSocket] = set()
        self._snapshot_provider = None  # callable returning snapshot dict
        self._stats_lock = Lock()
        self._total_broadcasts = 0
        self._total_bytes = 0
        self._window_s = 5.0
        self._recent: deque[tuple[float, int]] = deque()

    def set_snapshot_provider(self, fn):
        self._snapshot_provider = fn

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.add(ws)
        snap = self._snapshot_provider() if self._snapshot_provider else {"type": "loading"}
        await ws.send_json(safe_jsonable(snap))

    def disconnect(self, ws: WebSocket):
        self.active.discard(ws)

    def _prune(self, now: float) -> None:
        cutoff = now - self._window_s
        while self._recent and self._recent[0][0] < cutoff:
            self._recent.popleft()

    def _observe_broadcast(self, payload_size_bytes: int, now: float | None = None) -> None:
        ts = time.time() if now is None else float(now)
        with self._stats_lock:
            self._total_broadcasts += 1
            self._total_bytes += int(payload_size_bytes)
            self._recent.append((ts, int(payload_size_bytes)))
            self._prune(ts)

    def stats(self) -> dict:
        with self._stats_lock:
            now = time.time()
            self._prune(now)
            window_messages = len(self._recent)
            window_bytes = sum(sz for _, sz in self._recent)
            return {
                "window_s": self._window_s,
                "messages_per_s": window_messages / self._window_s,
                "bytes_per_s": window_bytes / self._window_s,
                "window_messages": window_messages,
                "window_bytes": window_bytes,
                "total_broadcasts": self._total_broadcasts,
                "total_bytes": self._total_bytes,
                "connected_clients": len(self.active),
                "captured_at": now,
            }

    async def broadcast(self, payload: dict):
        data = safe_jsonable(payload)
        payload_json = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
        payload_size = len(payload_json.encode("utf-8"))
        self._observe_broadcast(payload_size)
        dead = []
        for ws in list(self.active):
            try:
                await ws.send_text(payload_json)
            except (WebSocketDisconnect, RuntimeError):
                dead.append(ws)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)
