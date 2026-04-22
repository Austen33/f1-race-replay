# Pit Wall Prototype ⇄ Python Backend — Integration Plan v2


>
> **Goal.** Replace the Arcade/PySide6 visualizer with the HTML/React prototype in [project/Pit Wall.html](./Pit%20Wall.html), fed by the real FastF1 telemetry produced by [src/f1_data.py](../src/f1_data.py). Prototype visuals unchanged; every placeholder in [project/src/data.jsx](./src/data.jsx) replaced with live data.
>
> **Audience.** A coding agent executing end-to-end. Every path, contract, and verification command is explicit.
>
> **Constraint ladder.** (1) adapt the **prototype data layer** first; (2) add a thin **Python HTTP/WS bridge**; (3) only touch backend core (`src/f1_data.py`) if truly missing.
>
> **What changed from v1 (short list).**
> - Added **Step 0 (Security)** before any code.
> - Added **`/api/session/status`** with in-proc loading state + **frontend loading gate**.
> - Pinned **`fastf1.Cache.enable_cache(...)`** with a `--cache-dir` CLI flag.
> - Added **CORSMiddleware** config (explicit, not `*` when credentials).
> - Replaced `@app.on_event("startup")` with a **`lifespan` async context manager** (the `on_event` API is deprecated in current FastAPI).
> - Concrete **WS push throttle** (`MIN_PUSH_INTERVAL = 1/60`) + frame-skip at high speeds.
> - **Arcade import guard** in `_extract_geometry` with a pure-numpy fallback path.
> - **NumPy/Pandas-safe JSON**: custom `ORJSONResponse`-style default class (`FastAPI(default_response_class=...)`) and a `safe_jsonable()` helper used in `ws.send_json`.
> - Explicit **`track_statuses` → `flag_state`** bisect helper.
> - **Pydantic v2** syntax throughout (`model_config = ConfigDict(...)`).
> - Added **Uvicorn tuning** for WS (`--ws-max-size`, `--ws-ping-interval`, `--ws-max-queue`) with rationale.

---

## 0. Ground truth: what exists today

### 0.1 Backend (Python)

| Concern | File | Notes |
|---|---|---|
| Session loading (FastF1) | [src/f1_data.py](../src/f1_data.py) | `load_session(year, round, session_type)` |
| Race telemetry | [src/f1_data.py](../src/f1_data.py#L540) | `get_race_telemetry(session)` → `{frames, driver_colors, track_statuses, race_control_messages, total_laps, max_tyre_life}`. Cached to `computed_data/*.pkl`. |
| Qualifying telemetry | [src/f1_data.py](../src/f1_data.py#L1277) | `get_quali_telemetry(session)` |
| Schedule helpers | [src/f1_data.py](../src/f1_data.py#L1367) | `get_race_weekends_by_year(year)` |
| Circuit rotation | [src/f1_data.py](../src/f1_data.py#L170) | `get_circuit_rotation(session)` → degrees |
| Live stream service | [src/services/stream.py](../src/services/stream.py) | TCP JSON-lines server on `localhost:9999`. Used by Qt pit-wall windows. Must keep working. |
| Pit wall broadcast payload | [src/interfaces/race_replay.py](../src/interfaces/race_replay.py#L227) | `_broadcast_telemetry_state()` — canonical payload. |
| Insight windows | [src/insights/*.py](../src/insights/) | 10 PySide6 windows subscribing via `PitWallWindow`. |
| Engineer Chat (LLM) | [src/insights/engineer_chat_window.py](../src/insights/engineer_chat_window.py) | Groq + Tavily + Wikipedia + OpenF1. |
| Entry point | [main.py](../main.py) | PySide6 `RaceSelectionWindow` / CLI → Arcade replay. |
| Environment | [.env](../.env) | `GROQ_API_KEY`, `TAVILY_API_KEY`, `CEREBRAS_API_KEY`. **SEE STEP 0.** |

### 0.2 Prototype (React over Babel, no bundler)

| File | Role |
|---|---|
| [project/Pit Wall.html](./Pit%20Wall.html) | Loads React 18 + Babel + all `.jsx`. |
| [project/src/data.jsx](./src/data.jsx) | **Fictional.** `window.APEX = { TEAMS, DRIVERS, COMPOUNDS, CIRCUIT, SECTORS, DRS_ZONES, computeStandings, telemetryFor, lapTrace }` |
| [project/src/App.jsx](./src/App.jsx) | Root. Owns `t ∈ [0,1]`, `pinned`/`secondary`, camera, SC state. |
| [project/src/IsoTrack.jsx](./src/IsoTrack.jsx) | Iso track from `CIRCUIT`, `DRS_ZONES`, `SECTORS`. |
| [project/src/Leaderboard.jsx](./src/Leaderboard.jsx) | Classification. |
| [project/src/Telemetry.jsx](./src/Telemetry.jsx) | `DriverCard`, `CompareTraces`, `SectorTimes`. |
| [project/src/Panels.jsx](./src/Panels.jsx) | `StrategyStrip`, `GapViz`, `RaceFeed`. |
| [project/src/Controls.jsx](./src/Controls.jsx) | `TopBar`, `Timeline`, `CameraControls`. |

### 0.3 Canonical backend payload

See v1 §0.3. Unchanged — this plan targets exactly that shape.

---

## 1. Architecture

### 1.1 Topology

```
┌──────────────────────────────────────────────────────────────────────┐
│                   Python process (pit_wall_server.py)                │
│                                                                      │
│  FastF1 Cache ──► load_session ──► get_race_telemetry ──► frames     │
│         │                                   │                        │
│         │                                   ├─► TCP 9999 (unchanged) │
│         │                                   │   (existing Qt wins)   │
│         │                                   │                        │
│         ▼                                   ▼                        │
│  FastAPI + Uvicorn (HTTP + WS) on port 8000                          │
│   REST /api/seasons, /api/session/{load,status,summary,geometry,     │
│        race_control,results}, /api/playback/*, /api/chat             │
│   WS   /ws/telemetry                                                 │
│   MOUNT /app → project/ (serves Pit Wall.html + src/*.jsx)           │
└──────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
          http://localhost:8000/app/Pit%20Wall.html
```

**Why FastAPI + WS.** Browsers can't open raw TCP; we need HTTP anyway for session selection, geometry, chat, etc. TCP 9999 stays untouched — existing insight windows keep working. The new server is a **superset** consumer.

### 1.2 Process model

| Mode | How to start | Data path |
|---|---|---|
| **Headless web** (new default) | `python -m src.web.pit_wall_server --year 2026 --round 1` | Loads session → WS stream → React app. No Arcade. |
| **Legacy desktop** | `python main.py` (unchanged) | PySide6 → Arcade → TCP 9999. |

Coexist. Do **not** remove the desktop path in this task.

---

## 2. Backend work

All new Python under `src/web/`. Do not edit existing files except for the single refactor in §2.3 and the chat-module extraction in §2.8.

### 2.1 New files

```
src/web/
├── __init__.py
├── pit_wall_server.py    # FastAPI entry + argparse + lifespan
├── session_manager.py    # Loads + caches session in-proc
├── playback.py           # Wall-clock playhead, ticks at 25 Hz (60 Hz WS push cap)
├── ws_hub.py             # WebSocket connection manager + broadcaster
├── http_routes.py        # REST endpoints
├── chat_bridge.py        # Headless adapter for engineer chat
├── serialization.py      # NumPy/Pandas → JSON-safe helpers
├── flags.py              # track_statuses → flag_state bisect helper
└── schemas.py            # Pydantic v2 models (ConfigDict)
```

### 2.2 `session_manager.py`

```python
# src/web/session_manager.py
from pathlib import Path
import fastf1
from src.f1_data import load_session, get_race_telemetry, get_circuit_rotation

_LOAD_STATE = {"status": "idle", "progress": 0, "message": "", "year": None, "round": None}

def loading_state() -> dict:
    return dict(_LOAD_STATE)

class SessionManager:
    def __init__(self, cache_dir: Path):
        self._loaded: dict | None = None
        # Enable FastF1 HTTP cache ONCE per process.
        cache_dir.mkdir(parents=True, exist_ok=True)
        fastf1.Cache.enable_cache(str(cache_dir))

    def load(self, year: int, round_number: int, session_type: str = "R") -> dict:
        _LOAD_STATE.update(status="loading", progress=5,
                           message=f"Loading {year} R{round_number} {session_type}",
                           year=year, round=round_number)
        try:
            session = load_session(year, round_number, session_type)
            _LOAD_STATE.update(progress=30, message="Computing telemetry")
            race = get_race_telemetry(session, session_type=session_type)
            _LOAD_STATE.update(progress=70, message="Building geometry")

            geometry = _extract_geometry(race, session)
            driver_meta = _extract_driver_meta(session)
            rotation = get_circuit_rotation(session)

            self._loaded = {
                "year": year, "round": round_number, "session_type": session_type,
                "session": session,
                "frames": race["frames"],
                "driver_colors_hex": {k: "#{:02X}{:02X}{:02X}".format(*v)
                                      for k, v in race["driver_colors"].items()},
                "track_statuses": race["track_statuses"],
                "race_control_messages": race["race_control_messages"],
                "total_laps": race["total_laps"],
                "max_tyre_life": race["max_tyre_life"],
                "circuit_rotation": rotation,
                "geometry": geometry,
                "driver_meta": driver_meta,
                "event": _event_info(session, year, round_number, race),
                "lap_times": _precompute_lap_times(session),   # {code: {lap: seconds}}
                "fastest_qual_lap_s": _fastest_qual_lap_s(session),
            }
            _LOAD_STATE.update(status="ready", progress=100, message="Ready")
            return self._loaded
        except Exception as e:
            _LOAD_STATE.update(status="error", message=str(e))
            raise

    def current(self) -> dict | None:
        return self._loaded
```

Mount the singleton on `app.state.session_mgr`. Loading state is module-level so `/api/session/status` stays cheap.

### 2.3 Track geometry helper (with Arcade import guard)

```python
# src/web/session_manager.py (continued)
def _extract_geometry(race, session):
    """
    Try to reuse the existing builder. If it transitively imports Arcade and
    we're headless, fall back to the pure-numpy module we extract alongside.
    """
    example_lap = _pick_example_lap(session)   # same chain as main.py:50-67

    try:
        from src.ui_components import build_track_from_example_lap
        raw = build_track_from_example_lap(example_lap)
    except ImportError:
        from src.lib.track_geometry import build_track_pure
        raw = build_track_pure(example_lap)

    return _shape_geometry_payload(raw, session, race)
```

**The allowed refactor.** If `build_track_from_example_lap` imports Arcade at module top, extract the **pure-numpy** logic into new `src/lib/track_geometry.py` (`build_track_pure(example_lap) -> dict`) and have `ui_components.py` re-export from there. Nothing else in `ui_components.py` changes. This is the only permitted edit to existing code.

`_shape_geometry_payload` returns:
```python
{
  "centerline": {"x": [...], "y": [...]},
  "inner":      {"x": [...], "y": [...]},
  "outer":      {"x": [...], "y": [...]},
  "drs_zones":  [{"start_idx": i, "end_idx": j, "start_m": d0, "end_m": d1}],
  "sector_boundaries_m": [s1_end, s2_end],
  "rotation_deg": circuit_rotation_deg,
  "total_length_m": float,
  "bbox": {"x_min": .., "x_max": .., "y_min": .., "y_max": ..},
}
```

### 2.4 Driver metadata helper

```python
def _extract_driver_meta(session):
    out = {}
    for num in session.drivers:
        d = session.get_driver(num)
        out[d["Abbreviation"]] = {
            "code": d["Abbreviation"],
            "number": int(d.get("DriverNumber", 0) or 0),
            "full_name": d.get("FullName", ""),
            "team": d.get("TeamName", ""),
            "country": d.get("CountryCode", ""),
        }
    return out
```

### 2.5 `playback.py` — wall-clock playhead with throttle

```python
# src/web/playback.py
import asyncio, time
from src.web.ws_hub import WSHub

FPS = 25                      # source frame rate (see f1_data.py)
PUSH_HZ = 60                  # max WS push rate
MIN_PUSH_INTERVAL = 1.0 / PUSH_HZ

class Playback:
    def __init__(self, session_mgr, ws_hub: WSHub):
        self.session_mgr = session_mgr
        self.ws_hub = ws_hub
        self.frame_index: float = 0.0
        self.playback_speed: float = 1.0
        self.paused: bool = False
        self._task: asyncio.Task | None = None
        self._last_push = 0.0
        self._last_broadcast_t_s: float = 0.0   # for new_rc_events diff

    async def start(self):
        if self._task: return
        self._task = asyncio.create_task(self._run())

    async def stop(self):
        if self._task:
            self._task.cancel()
            try: await self._task
            except asyncio.CancelledError: pass
            self._task = None

    def set_speed(self, s: float):
        self.playback_speed = max(0.1, min(256.0, float(s)))
        asyncio.create_task(self._push_now())

    def toggle_pause(self, value: bool | None = None):
        self.paused = (not self.paused) if value is None else bool(value)
        asyncio.create_task(self._push_now())

    def seek(self, t_fraction: float):
        n = self._n_frames()
        self.frame_index = max(0.0, min(float(t_fraction), 1.0)) * (n - 1)
        asyncio.create_task(self._push_now())

    def _n_frames(self) -> int:
        loaded = self.session_mgr.current()
        return len(loaded["frames"]) if loaded else 1

    async def _run(self):
        loop = asyncio.get_event_loop()
        prev = loop.time()
        while True:
            await asyncio.sleep(1 / FPS)
            now = loop.time()
            dt = now - prev
            prev = now
            if not self.paused:
                self.frame_index = min(self.frame_index + dt * FPS * self.playback_speed,
                                       self._n_frames() - 1)
            # Push cap — at 256× we'd otherwise flood clients.
            if now - self._last_push >= MIN_PUSH_INTERVAL:
                await self._push_now(loop_time=now)

    async def _push_now(self, loop_time: float | None = None):
        payload = self._build_frame_payload()
        await self.ws_hub.broadcast(payload)
        self._last_push = loop_time or asyncio.get_event_loop().time()
        self._last_broadcast_t_s = payload.get("t_seconds", self._last_broadcast_t_s)
```

Contract for `_build_frame_payload()` is §3.4.

### 2.6 `ws_hub.py` — ConnectionManager pattern (FastAPI idiom)

```python
# src/web/ws_hub.py
from fastapi import WebSocket, WebSocketDisconnect
from src.web.serialization import safe_jsonable

class WSHub:
    def __init__(self):
        self.active: set[WebSocket] = set()
        self._snapshot_provider = None   # callable returning snapshot dict

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
```

The FastAPI docs show the same pattern (`ConnectionManager.connect/disconnect/broadcast`) — we're staying on the documented idiom so we get robust `WebSocketDisconnect` handling.

### 2.7 `serialization.py` — NumPy/Pandas safety

This is the fix for the silent-crash class mentioned in feedback #6. FastAPI's default JSON encoder (Starlette's `jsonable_encoder`) does not cover NumPy scalars or Pandas Timestamps, both of which come straight out of FastF1.

```python
# src/web/serialization.py
import math
from datetime import datetime, date
import numpy as np
import pandas as pd

_PRIMITIVES = (str, int, float, bool, type(None))

def safe_jsonable(obj):
    # Fast paths
    if isinstance(obj, _PRIMITIVES):
        if isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)):
            return None
        return obj
    if isinstance(obj, dict):
        return {str(k): safe_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [safe_jsonable(v) for v in obj]
    # NumPy
    if isinstance(obj, np.integer): return int(obj)
    if isinstance(obj, np.floating):
        f = float(obj)
        return None if (math.isnan(f) or math.isinf(f)) else f
    if isinstance(obj, np.bool_): return bool(obj)
    if isinstance(obj, np.ndarray): return [safe_jsonable(v) for v in obj.tolist()]
    # Pandas
    if isinstance(obj, pd.Timestamp): return obj.isoformat()
    if isinstance(obj, pd.Timedelta): return obj.total_seconds()
    if isinstance(obj, (pd.Series,)): return [safe_jsonable(v) for v in obj.tolist()]
    # datetime
    if isinstance(obj, (datetime, date)): return obj.isoformat()
    # Last-ditch
    return str(obj)
```

Use `safe_jsonable()` before every `ws.send_json` and inside any REST endpoint that returns raw FastF1 output. We deliberately don't rely on a custom `JSONResponse` for WS payloads because FastAPI's `ws.send_json` bypasses response classes.

### 2.8 `chat_bridge.py` + chat-module extraction

Current state: all chat logic is inside the PySide6 widget in [engineer_chat_window.py](../src/insights/engineer_chat_window.py).

**Permitted refactor:** extract module-level helpers (Groq/Cerebras call, Tavily lookup, Wikipedia fetch, OpenF1 query, system-prompt builder) into top-level functions inside the **same file**. The widget keeps calling them. The only new consumer is:

```python
# src/web/chat_bridge.py
from src.insights.engineer_chat_window import (
    build_system_prompt,
    call_llm_with_fallback,
    search_tavily,
    fetch_wikipedia,
    fetch_openf1,
)

def answer(question: str, live_context: dict) -> dict:
    # live_context = {"t": float, "pinned": str, "frame": dict, "rc": [...]}
    system = build_system_prompt(live_context)
    citations = []
    # Optionally enrich with tool calls (Tavily/Wiki/OpenF1) per existing logic.
    reply = call_llm_with_fallback(system=system, user=question)
    return {"reply": reply, "citations": citations}
```

Do not add retries, caching, or rate-limits at this layer beyond what the existing widget already does.

### 2.9 `flags.py` — track-status → flag_state bridge

Feedback item #7. `track_statuses` from `get_race_telemetry()` is a sparse mapping of frame_index → status code. We must bisect.

```python
# src/web/flags.py
from bisect import bisect_right

FLAG_MAP = {"1": "green", "2": "yellow", "4": "sc", "5": "red", "6": "vsc", "7": "vsc"}

class FlagBisect:
    def __init__(self, track_statuses: dict):
        items = sorted((int(k), str(v)) for k, v in track_statuses.items())
        self._keys = [k for k, _ in items]
        self._vals = [v for _, v in items]

    def at(self, frame_index: int) -> str:
        if not self._keys: return "green"
        i = bisect_right(self._keys, frame_index) - 1
        if i < 0: return "green"
        return FLAG_MAP.get(self._vals[i], "green")
```

Build once per session load, reuse each tick.

### 2.10 `http_routes.py` — REST endpoints

All JSON. All paths under `/api`.

| Method | Path | Body / Query | Returns | Notes |
|---|---|---|---|---|
| GET  | `/api/session/status` | – | `{"status": "idle\|loading\|ready\|error", "progress": 0..100, "message": "...", "year": int?, "round": int?}` | **New in v2.** Polled by the browser during cold load. |
| GET  | `/api/seasons` | – | `{"seasons": [2018..2026]}` | Static list initially. |
| GET  | `/api/seasons/{year}/rounds` | – | `[{round_number, event_name, date, country, type, session_dates}]` | Wraps `get_race_weekends_by_year`. |
| POST | `/api/session/load` | `{"year":2026,"round":1,"session_type":"R"}` | `202 {"ok":true,"status":"loading"}` | **Non-blocking** via `BackgroundTasks`. Client polls `/api/session/status`. |
| GET  | `/api/session/summary` | – | §3.1 | 404 until `status == ready`. |
| GET  | `/api/session/geometry` | – | §3.2 | 404 until ready. |
| GET  | `/api/session/race_control` | `?since=<seconds>` | `[rc_event]` | Full list if `since` omitted. |
| GET  | `/api/session/results` | – | `[{code, pos, gap_s, status}]` | Best-effort last frame; Phase-2 replaces with real results. |
| POST | `/api/playback/play` | – | `{ok: true}` | |
| POST | `/api/playback/pause` | – | `{ok: true}` | |
| POST | `/api/playback/seek` | `{"t": 0.42}` | `{ok: true}` | |
| POST | `/api/playback/speed` | `{"speed": 2}` | `{ok: true}` | |
| POST | `/api/chat` | `{"message": "...", "context": {...}}` | `{reply, citations}` | Rate-limit: 1 req / 2 s / client IP (in-proc token bucket). |

### 2.11 `pit_wall_server.py` — lifespan + CORS + encoder wiring

```python
# src/web/pit_wall_server.py
import argparse, asyncio
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from src.web.session_manager import SessionManager
from src.web.ws_hub import WSHub
from src.web.playback import Playback
from src.web.http_routes import register_http
from src.web.ws_routes import register_ws    # thin file with @app.websocket("/ws/telemetry")

def build_app(year: int, round_number: int, session_type: str, cache_dir: Path) -> FastAPI:
    session_mgr = SessionManager(cache_dir=cache_dir)
    ws_hub = WSHub()
    playback = Playback(session_mgr, ws_hub)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Startup: kick off session load on a worker thread so the server answers
        # /api/session/status immediately.
        loop = asyncio.get_event_loop()
        loop.run_in_executor(None, session_mgr.load, year, round_number, session_type)
        await playback.start()
        yield
        # Shutdown
        await playback.stop()

    app = FastAPI(lifespan=lifespan)
    app.state.session_mgr = session_mgr
    app.state.ws_hub = ws_hub
    app.state.playback = playback

    # CORS. When serving the HTML from the same origin (/app) you don't strictly
    # need this, but we enable it to make `file://` and alternative dev servers
    # actually fail loudly instead of silently 0-byte.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:8000", "http://127.0.0.1:8000",
            "http://localhost:5173", "http://127.0.0.1:5173",
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    register_http(app)
    register_ws(app)
    # Serve the prototype at /app/Pit%20Wall.html
    app.mount("/app", StaticFiles(directory="project", html=True), name="app")
    return app

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--year", type=int, default=2026)
    p.add_argument("--round", dest="round_number", type=int, default=1)
    p.add_argument("--session-type", default="R")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--cache-dir", type=Path, default=Path("cache/fastf1"))
    args = p.parse_args()
    app = build_app(args.year, args.round_number, args.session_type, args.cache_dir)
    uvicorn.run(
        app, host=args.host, port=args.port,
        ws_max_size=32 * 1024 * 1024,    # 32 MB — snapshot with geometry can be large
        ws_ping_interval=20.0,
        ws_ping_timeout=20.0,
        ws_max_queue=64,
    )

if __name__ == "__main__":
    main()
```

Two things worth flagging from the Context7 docs:

- **Lifespan over `on_event`.** FastAPI's current docs use `@asynccontextmanager` + `lifespan=...`. v1 used `@app.on_event("startup")`, which is deprecated; v2 uses lifespan.
- **Uvicorn WS knobs.** `--ws-max-size` default is 16 MB; our initial snapshot (geometry arrays) can exceed that on long circuits, so bump to 32 MB. `--ws-ping-interval` default 20 s is fine. `--ws-max-queue` default 32 is tight; bump to 64 to absorb send bursts at 4× playback.

### 2.12 Dependency additions

Append to [requirements.txt](../requirements.txt):
```
fastapi>=0.115
uvicorn[standard]>=0.30
pydantic>=2.6
websockets>=12
```
(Existing `groq`, `tavily-python`, `python-dotenv`, `cerebras-cloud-sdk`, `fastf1`, `pandas`, `numpy` stay.)

---

## 3. Wire contracts (frozen)

Identical to v1 §3 except:
- `GET /api/session/status` added (§2.10).
- `POST /api/session/load` now returns 202 immediately; payload shape updated.
- Snapshot `type: "loading"` explicitly documented as the first message when a client connects before the session is ready.
- Pydantic models in `schemas.py` use v2 syntax:

```python
# src/web/schemas.py
from pydantic import BaseModel, ConfigDict
from typing import Literal

class StandingRow(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)
    pos: int
    code: str
    gap_s: float | None
    interval_s: float | None
    last_lap_s: float | None
    best_lap_s: float | None
    compound_int: int
    tyre_age_laps: int
    status: Literal["RUN", "OUT", "PIT"]
    in_pit: bool
    in_drs: bool
    x: float
    y: float
    lap: int
    rel_dist: float
    fraction: float
    speed_kph: float
    gear: int
    drs_raw: int
    throttle_pct: float
    brake_pct: float

class FramePayload(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)
    type: Literal["frame"] = "frame"
    frame_index: int
    t: float
    t_seconds: float
    lap: int
    total_laps: int
    clock: str
    track_status: str
    flag_state: Literal["green", "yellow", "red", "sc", "vsc"]
    playback_speed: float
    is_paused: bool
    weather: dict
    safety_car: dict | None
    standings: list[StandingRow]
    new_rc_events: list[dict]
```

These are validation types at the boundary — we still serialize via `safe_jsonable` on the way out because the server assembles dicts, not model instances, to avoid a Pydantic round-trip per 25 Hz tick.

**Frame payload (unchanged wire shape):** see v1 §3.4.

**Gap/interval derivation, last/best lap, in_pit/status, flag_state mapping:** see v1 §3.4.1–§3.4.4, with the §2.9 `FlagBisect` used for `flag_state`.

**Error & reconnect:**
- If a client connects before `SessionManager.load` has completed → server sends `{"type":"loading", "status":"loading", "progress":...}` and keeps the socket open. On `status == ready` it sends a full `snapshot`.
- On session switch → `{"type":"reset"}` then a new `snapshot`. Clients clear local state.

---

## 4. Frontend work

Prototype stays bundler-free. New files loaded via `<script type="text/babel" src="...">` from [Pit Wall.html](./Pit%20Wall.html). Only **`data.jsx`** (rewrite) and **`App.jsx`** (wiring) are modified in place. CSS and other components untouched.

### 4.1 New files

```
project/src/
├── apex_client.jsx     # HTTP + WS client, exposes window.APEX_CLIENT
├── live_state.jsx      # WS subscriber, exposes window.LIVE.{LiveProvider, useLive}
├── loading_gate.jsx    # NEW in v2: polls /api/session/status and gates the UI
└── data.jsx            # REWRITTEN: live-data shim with the same window.APEX shape
```

Add to [Pit Wall.html](./Pit%20Wall.html), **before** the existing `data.jsx` tag:

```html
<script type="text/babel" src="src/apex_client.jsx"></script>
<script type="text/babel" src="src/live_state.jsx"></script>
<script type="text/babel" src="src/loading_gate.jsx"></script>
```

### 4.2 `apex_client.jsx`

```jsx
// Thin HTTP + WS client. Exposes window.APEX_CLIENT.
const BASE = `${location.protocol}//${location.host}`;
const WS_BASE = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host;

async function get(path) {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}
async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

function openSocket(onMessage) {
  let ws;
  let retry = 0;
  const connect = () => {
    ws = new WebSocket(WS_BASE + "/ws/telemetry");
    ws.onmessage = (ev) => { try { onMessage(JSON.parse(ev.data)); } catch {} };
    ws.onclose = () => {
      const delay = Math.min(1000 * (2 ** retry), 10000); // 1s..10s exponential backoff
      retry = Math.min(retry + 1, 4);
      setTimeout(connect, delay);
    };
    ws.onopen = () => { retry = 0; };
  };
  connect();
  return { close: () => ws && ws.close() };
}

window.APEX_CLIENT = { get, post, openSocket };
```

### 4.3 `live_state.jsx`

```jsx
const LiveCtx = React.createContext(null);
function LiveProvider({ children }) {
  const [snapshot, setSnap] = React.useState(null);
  const [frame, setFrame]   = React.useState(null);
  const [rc, setRc]         = React.useState([]);
  const [playback, setPb]   = React.useState({ speed: 1, is_paused: false });
  const [loading, setLoading] = React.useState({ status: "loading", progress: 0 });

  React.useEffect(() => {
    const h = window.APEX_CLIENT.openSocket((msg) => {
      if (msg.type === "loading") {
        setLoading({ status: msg.status || "loading", progress: msg.progress || 0, message: msg.message });
      } else if (msg.type === "snapshot" || msg.type === "reset") {
        setLoading({ status: "ready", progress: 100 });
        setSnap(msg);
        setRc(msg.race_control_history || []);
        if (msg.playback) setPb(msg.playback);
      } else if (msg.type === "frame") {
        setFrame(msg);
        setPb((p) => ({ ...p, speed: msg.playback_speed, is_paused: msg.is_paused }));
        if (msg.new_rc_events?.length) {
          setRc((prev) => [...msg.new_rc_events.slice().reverse(), ...prev]);
        }
      }
    });
    return () => h.close();
  }, []);

  return <LiveCtx.Provider value={{ snapshot, frame, rc, playback, setPb, loading }}>{children}</LiveCtx.Provider>;
}
const useLive = () => React.useContext(LiveCtx);
window.LIVE = { LiveProvider, useLive };
```

### 4.4 `loading_gate.jsx` (new)

Keeps the UI intentionally blank behind a progress overlay during cold load so the user sees why nothing is moving. Overlay is absolutely-positioned; no CSS changes to existing components.

```jsx
function LoadingGate({ children }) {
  const { loading } = window.LIVE.useLive();
  const [poll, setPoll] = React.useState(null);

  // Poll /api/session/status as a belt-and-braces for the WS loading pings.
  React.useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await window.APEX_CLIENT.get("/api/session/status");
        if (alive) setPoll(s);
      } catch {}
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const status = loading?.status || poll?.status || "loading";
  const progress = Math.max(loading?.progress || 0, poll?.progress || 0);
  if (status === "ready") return children;
  return (
    <>
      {children}
      <div style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)",
        color: "#fff", display: "flex", alignItems: "center",
        justifyContent: "center", flexDirection: "column", zIndex: 9999,
        fontFamily: "monospace",
      }}>
        <div style={{ fontSize: 14, letterSpacing: 3, marginBottom: 12 }}>LOADING SESSION</div>
        <div style={{ width: 320, height: 4, background: "#333" }}>
          <div style={{ width: `${progress}%`, height: "100%", background: "#FF1E00", transition: "width 0.3s" }} />
        </div>
        <div style={{ marginTop: 10, fontSize: 11, opacity: 0.7 }}>{poll?.message || "..."}</div>
      </div>
    </>
  );
}
window.LOADING_GATE = LoadingGate;
```

### 4.5 `data.jsx` — rewrite

Unchanged from v1 §4.4 *except*: guard every `f.standings.find(...)` / `f.standings.map(...)` against `f?.standings` being undefined, since the first frame may arrive before the snapshot finishes populating `window.APEX`.

(Full code identical to v1 §4.4; treat v1 as the source for this file.)

### 4.6 `App.jsx` — changes

Same as v1 §4.5, plus two wrappers at mount time:

```jsx
ReactDOM.createRoot(document.getElementById("root")).render(
  <window.LIVE.LiveProvider>
    <window.LOADING_GATE>
      <App />
    </window.LOADING_GATE>
  </window.LIVE.LiveProvider>
);
```

All other steps from v1 §4.5 apply verbatim (install APEX on snapshot, expose `__LIVE_FRAME`, replace local playhead with server-authoritative values, rewire playback controls to POST).

### 4.7 Fields the prototype wants that don't exist

Unchanged from v1 §4.6:
- `ers`, `fuel` → render 0.
- `rpm` → derived (documented synthetic).
- `lapTrace`, `SectorTimes`, `StrategyStrip` stints → Phase-2.

### 4.8 Styling / layout

**Do not modify** any CSS, colors, font stacks, HUD corner artwork, scan-line animations, or layout geometry. Only data changes.

---

## 5. Phase-2 follow-ups

Unchanged from v1 §5. Listed for reference; do not implement in Phase-1.

---

## 6. Execution order

Each step ends with a concrete verification. Do them in order.


### Step 1 — Scaffolding

1. Create `src/web/` with all files from §2.1 (empty stubs OK).
2. Append deps to [requirements.txt](../requirements.txt) (§2.12).
3. `pip install -r requirements.txt`.
4. **Verify:** `python -c "import fastapi, uvicorn, pydantic; print(fastapi.__version__, pydantic.VERSION)"` prints ≥ 0.115 and ≥ 2.6.

### Step 2 — Session manager + cache + geometry

1. Implement `SessionManager.load` (§2.2), wiring `fastf1.Cache.enable_cache(cache_dir)`.
2. Implement `_extract_driver_meta` (§2.4) and `_extract_geometry` (§2.3) with the Arcade-import guard. If the guard trips, extract `src/lib/track_geometry.py` as specified.
3. **Verify:**
   ```python
   from pathlib import Path
   from src.web.session_manager import SessionManager
   m = SessionManager(Path("cache/fastf1"))
   loaded = m.load(2026, 1, "R")
   print(len(loaded["frames"]), loaded["event"], list(loaded["driver_meta"])[:3])
   ```
   Prints non-zero frames, an `event` dict, and three-letter codes.

### Step 3 — REST + lifespan + CORS (no WS yet)

1. Implement `/api/session/status`, `/api/seasons`, `/api/seasons/{year}/rounds`, `/api/session/load` (with `BackgroundTasks`), `/api/session/summary`, `/api/session/geometry`, `/api/session/race_control`.
2. Wire the lifespan context manager from §2.11 so session load runs on an executor thread and `/api/session/status` responds instantly.
3. Mount static files on `/app`.
4. **Verify:**
   - `python -m src.web.pit_wall_server --year 2026 --round 1 &` → server starts immediately.
   - `curl localhost:8000/api/session/status` returns `{"status":"loading",...}` within < 500 ms.
   - After load: `curl localhost:8000/api/session/summary | jq '.drivers | length'` ~ 20.
   - `curl localhost:8000/api/session/geometry | jq '.drs_zones | length'` > 0.
   - Browser at `http://localhost:8000/app/Pit%20Wall.html` renders the prototype (fake data still — expected until Step 5).

### Step 4 — Playback + WebSocket

1. Implement `Playback.start/stop/set_speed/toggle_pause/seek` (§2.5) with the 60 Hz push cap.
2. Implement `WSHub` (§2.6) using the FastAPI `ConnectionManager` idiom.
3. Implement `_build_frame_payload()` per §3.4:
   - Reuse `_project_to_reference` / `track_tree` logic from [race_replay.py](../src/interfaces/race_replay.py). If easier, move it into `src/lib/track_geometry.py` (already extracted in Step 2).
   - Gaps/intervals via the ring-buffer bisect (v1 §3.4.1).
   - Last/best lap via precomputed `session.laps` lookup (v1 §3.4.2).
   - `status` / `in_pit` / `in_drs` per v1 §3.4.3.
   - `flag_state` via `FlagBisect` (§2.9).
4. Wire `POST /api/playback/*` into the `Playback` instance.
5. **Verify:**
   ```bash
   python -c "import asyncio,websockets,json
   async def m():
     async with websockets.connect('ws://localhost:8000/ws/telemetry') as w:
       print(json.loads(await w.recv())['type'])
       for _ in range(3): print(json.loads(await w.recv())['frame_index'])
   asyncio.run(m())"
   ```
   Expect: `snapshot` (or `loading` then `snapshot` after session is ready), then three ascending `frame_index` values.

### Step 5 — Prototype wiring

1. Create [project/src/apex_client.jsx](./src/apex_client.jsx) per §4.2.
2. Create [project/src/live_state.jsx](./src/live_state.jsx) per §4.3.
3. Create [project/src/loading_gate.jsx](./src/loading_gate.jsx) per §4.4.
4. Rewrite [project/src/data.jsx](./src/data.jsx) per §4.5 / v1 §4.4.
5. Modify [project/src/App.jsx](./src/App.jsx) per §4.6 / v1 §4.5.
6. Add the three new `<script>` tags to [Pit Wall.html](./Pit%20Wall.html) (§4.1).
7. **Verify (manual, browser):**
   - Open `http://localhost:8000/app/Pit%20Wall.html`. During cold load, the loading overlay shows a live progress bar.
   - Once ready: top bar shows the real event name + round.
   - Leaderboard has real 3-letter codes and team colors from the backend.
   - Track shape is the real circuit.
   - Cars move during playback; timeline scrub seeks (server-authoritative).
   - Race control feed populates with real flags.
   - SC glyph appears during SC periods; flag badge matches `flag_state`.
   - Weather numbers match an adjacent `curl localhost:8000/api/session/summary`.

### Step 6 — Playback round-trip

1. Play/pause button toggles `is_paused` server-side (visible in subsequent frame messages).
2. Speed buttons (0.5 / 1 / 2 / 4) change `playback_speed` server-side.
3. Scrubber drag translates to `POST /api/playback/seek` with `t ∈ [0,1]`, server emits a frame at the new index within ~40 ms.

### Step 7 — Documentation

1. Add top-level `README_WEB.md`:
   - How to run: `python -m src.web.pit_wall_server --year ... --round ... --cache-dir ...`.
   - Architecture diagram (copy §1.1).
   - How to add a new panel that reads live data (`const live = window.LIVE.useLive(); ...`).
2. Add a short pointer to the new web mode in [README.md](../README.md).

---

## 7. Acceptance checklist

- [ ] `python -m src.web.pit_wall_server --year 2026 --round 1` starts without error, serves the prototype at `/app/Pit%20Wall.html`, and `/api/session/status` is answering within 500 ms of startup.
- [ ] Loading overlay renders during cold load and disappears on snapshot arrival.
- [ ] Prototype renders with **no fictional drivers/teams/colors** — every value traceable to the backend.
- [ ] Track geometry on screen matches the output of `build_track_from_example_lap` (or the pure-numpy equivalent).
- [ ] DRS zones painted red match the indices in `/api/session/geometry`.
- [ ] Leaderboard positions match `standings[*].pos` and update at ≥ 25 Hz (≤ 60 Hz).
- [ ] `gap` and `interval` columns display real seconds, never fabricated values.
- [ ] `lap / totalLaps` top bar matches FastF1 truth.
- [ ] Safety car glyph appears iff `frame.safety_car` is non-null; flag badge mirrors `flag_state`.
- [ ] Race control feed contains FastF1 messages in reverse chronological order with correct tag buckets.
- [ ] Play/pause/seek/speed round-trip through `POST /api/playback/*`; server is authoritative source of `t`.
- [ ] `IsoTrack`, `Leaderboard`, `Panels`, `Telemetry`, `Controls` diff-free; only `App.jsx` and `data.jsx` modified in-place.
- [ ] Existing desktop path (`python main.py`) and TCP insight windows still work.
- [ ] No fictional data paths in `data.jsx` except `lapTrace` (documented Phase-2) and synth `rpm/ers/fuel`.
- [ ] No NumPy/Pandas scalar leaks into the WS stream (spot-check `jq 'type' < sample_frame.json` — all values should be native JSON types).
- [ ] `.env` rotated, `.env` in `.gitignore`, no keys in `src/web/` or `project/src/`.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Cold load takes 30–120 s; browser appears dead. | `/api/session/status` + `loading_gate.jsx` overlay. |
| `fastf1.Cache.enable_cache` never called → API rate limit. | Called explicitly in `SessionManager.__init__` with `--cache-dir`. |
| `build_track_from_example_lap` transitively imports Arcade. | `_extract_geometry` try/except ImportError → `src/lib/track_geometry.build_track_pure` fallback. Refactor is limited to extracting the pure-numpy path. |
| FastAPI's JSON encoder crashes on NumPy / Pandas types. | `safe_jsonable()` wraps every `ws.send_json` and REST payload sourced from FastF1. |
| WebSocket flood at 256× playback. | 60 Hz push cap (`MIN_PUSH_INTERVAL`). UI already tolerates non-contiguous `frame_index`. |
| Large snapshot exceeds Uvicorn's 16 MB WS max. | Start Uvicorn with `ws_max_size=32 * 1024 * 1024`; geometry is already float arrays in plain JSON. |
| `track_statuses` is sparse; naive lookup returns stale flags. | `FlagBisect` with `bisect_right`. |
| Gap/interval spikes at lap boundaries. | Ring-buffer interpolation (v1 §3.4.1), not instantaneous deltas. |
| `.env` keys previously committed. | Step 0 rotates them before any code is written. |
| Pydantic v1 syntax leaks in. | `schemas.py` uses `ConfigDict` throughout; v1 syntax (`class Config:`) will not validate in Pydantic ≥ 2.6. |
| CORS silently blocks a `file://` load. | CORS explicitly configured; and the plan mandates serving via `StaticFiles`. |
| Engineer chat hits Groq/Tavily per request. | `/api/chat` rate-limited (1 req / 2 s / client IP). |

---

## 9. Appendix — field-by-field mapping

Unchanged from v1 §9. The mapping is the authoritative contract for the data layer shim.
