from fastapi import WebSocket, WebSocketDisconnect
from src.web.serialization import safe_jsonable


class WSHub:
    def __init__(self):
        self.active: set[WebSocket] = set()
        self._snapshot_provider = None  # callable returning snapshot dict

    def set_snapshot_provider(self, fn):
        self._snapshot_provider = fn

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.add(ws)
        snap = self._snapshot_provider() if self._snapshot_provider else {"type": "loading"}
        await ws.send_json(safe_jsonable(snap))

    def disconnect(self, ws: WebSocket):
        self.active.discard(ws)

    async def broadcast(self, payload: dict):
        data = safe_jsonable(payload)
        dead = []
        for ws in list(self.active):
            try:
                await ws.send_json(data)
            except (WebSocketDisconnect, RuntimeError):
                dead.append(ws)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)
