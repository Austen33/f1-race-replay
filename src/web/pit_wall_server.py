import argparse
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from src.web.session_manager import SessionManager, loading_state
from src.web.ws_hub import WSHub
from src.web.playback import Playback, build_snapshot, standings_from_frame
from src.web.http_routes import register_http
from src.web.ws_routes import register_ws


def build_app(year: int, round_number: int, session_type: str, cache_dir: Path) -> FastAPI:
    session_mgr = SessionManager(cache_dir=cache_dir)
    ws_hub = WSHub()
    playback = Playback(session_mgr, ws_hub)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Startup: kick off session load on a worker thread so the server
        # answers /api/session/status immediately.
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

    # CORS
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:8000",
            "http://127.0.0.1:8000",
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    register_http(app)
    register_ws(app)

    # Serve the prototype at /app/Pit%20Wall.html
    project_dir = Path(__file__).resolve().parent.parent.parent / "project"
    if project_dir.is_dir():
        app.mount("/app", StaticFiles(directory=str(project_dir), html=True), name="app")

    # Snapshot provider for WS hub — sends full state on connect
    def _snapshot():
        loaded = session_mgr.current()
        state = loading_state()
        if loaded is None:
            return {"type": "loading", **state}
        return build_snapshot(loaded, playback)

    ws_hub.set_snapshot_provider(_snapshot)

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
        app,
        host=args.host,
        port=args.port,
        ws_max_size=32 * 1024 * 1024,
        ws_ping_interval=20.0,
        ws_ping_timeout=20.0,
        ws_max_queue=64,
    )


if __name__ == "__main__":
    main()
