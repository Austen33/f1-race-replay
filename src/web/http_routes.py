import time
from fastapi import APIRouter, BackgroundTasks, Request
from src.web.session_manager import loading_state
from src.web.serialization import safe_jsonable
from src.f1_data import get_race_weekends_by_year

router = APIRouter(prefix="/api")


# ---------------------------------------------------------------------------
# Session status
# ---------------------------------------------------------------------------

@router.get("/session/status")
def session_status():
    return safe_jsonable(loading_state())


# ---------------------------------------------------------------------------
# Seasons
# ---------------------------------------------------------------------------

@router.get("/seasons")
def seasons():
    return {"seasons": list(range(2018, 2027))}


@router.get("/seasons/{year}/rounds")
def season_rounds(year: int):
    try:
        rounds = get_race_weekends_by_year(year)
        return safe_jsonable(rounds)
    except Exception as e:
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# Session load (non-blocking)
# ---------------------------------------------------------------------------

@router.post("/session/load")
def session_load(
    payload: dict,
    background_tasks: BackgroundTasks,
    request: Request,
):
    year = payload.get("year", 2026)
    round_number = payload.get("round", 1)
    session_type = payload.get("session_type", "R")

    mgr = request.app.state.session_mgr

    def _load():
        try:
            mgr.load(year, round_number, session_type)
        except Exception:
            pass  # _LOAD_STATE already set to error

    background_tasks.add_task(_load)
    return {"ok": True, "status": "loading"}


# ---------------------------------------------------------------------------
# Session data (require loaded session)
# ---------------------------------------------------------------------------

def _require_loaded(request: Request) -> dict:
    loaded = request.app.state.session_mgr.current()
    if loaded is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="No session loaded")
    return loaded


@router.get("/session/summary")
def session_summary(request: Request):
    loaded = _require_loaded(request)
    ev = loaded["event"]
    dm = loaded["driver_meta"]
    return safe_jsonable({
        "event": ev,
        "total_laps": loaded["total_laps"],
        "drivers": list(dm.values()),
        "circuit_rotation": loaded["circuit_rotation"],
    })


@router.get("/session/geometry")
def session_geometry(request: Request):
    loaded = _require_loaded(request)
    geo = loaded["geometry"]
    # Strip internal keys before sending to client
    public = {k: v for k, v in geo.items() if not k.startswith("_")}
    return safe_jsonable(public)


@router.get("/session/race_control")
def session_race_control(request: Request, since: float | None = None):
    loaded = _require_loaded(request)
    msgs = loaded["race_control_messages"]
    if since is not None:
        msgs = [m for m in msgs if m.get("time", 0) > since]
    return safe_jsonable(msgs)


@router.get("/session/results")
def session_results(request: Request):
    loaded = _require_loaded(request)
    frames = loaded["frames"]
    if not frames:
        return []
    last = frames[-1]
    drivers = last.get("drivers", {})
    rows = []
    for code, d in drivers.items():
        rows.append({
            "code": code,
            "pos": d.get("position", 0),
            "gap_s": None,
            "status": "RUN",
        })
    rows.sort(key=lambda r: r["pos"])
    return safe_jsonable(rows)


# ---------------------------------------------------------------------------
# Playback controls
# ---------------------------------------------------------------------------

@router.post("/playback/play")
def playback_play(request: Request):
    pb = request.app.state.playback
    pb.toggle_pause(value=False)
    return {"ok": True}


@router.post("/playback/pause")
def playback_pause(request: Request):
    pb = request.app.state.playback
    pb.toggle_pause(value=True)
    return {"ok": True}


@router.post("/playback/seek")
def playback_seek(payload: dict, request: Request):
    pb = request.app.state.playback
    t = payload.get("t", 0.0)
    pb.seek(float(t))
    return {"ok": True}


@router.post("/playback/speed")
def playback_speed(payload: dict, request: Request):
    pb = request.app.state.playback
    s = payload.get("speed", 1.0)
    pb.set_speed(float(s))
    return {"ok": True}


# ---------------------------------------------------------------------------
# Chat
# ---------------------------------------------------------------------------

_last_chat_ts: dict[str, float] = {}


@router.post("/chat")
def chat(payload: dict, request: Request):
    client_ip = request.client.host if request.client else "unknown"
    now = time.time()
    if now - _last_chat_ts.get(client_ip, 0) < 2.0:
        return {"reply": "Rate limited — wait 2 s between messages.", "citations": []}
    _last_chat_ts[client_ip] = now

    from src.web.chat_bridge import answer
    question = payload.get("message", "")
    context = payload.get("context", {})
    return answer(question, context)


# ---------------------------------------------------------------------------
# Registration helper
# ---------------------------------------------------------------------------

def register_http(app):
    app.include_router(router)
