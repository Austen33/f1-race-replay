# Pit Wall Web Interface

Browser-based F1 race replay console powered by the Python FastF1 backend.

## Quick Start

```bash
pip install -r requirements.txt
python -m src.web.pit_wall_server --year 2026 --round 1
```

Open **http://localhost:8000/app/Pit%20Wall.html** in a modern browser (Chrome/Edge/Firefox).

A loading overlay tracks session initialisation (FastF1 data fetch + telemetry computation). Once ready the full Pit Wall UI appears with live data.

### CLI Flags

| Flag | Default | Description |
|---|---|---|
| `--year` | 2026 | Championship year |
| `--round` | 1 | Round number (1-based) |
| `--session-type` | R | `R` = Race, `Q` = Qualifying, `SQ` = Sprint Qualifying |
| `--host` | 127.0.0.1 | Bind address |
| `--port` | 8000 | Bind port |
| `--cache-dir` | cache/fastf1 | FastF1 HTTP cache directory |

### Examples

```bash
# 2025 British Grand Prix
python -m src.web.pit_wall_server --year 2025 --round 12

# Qualifying session on a custom port
python -m src.web.pit_wall_server --year 2025 --round 12 --session-type Q --port 9000

# Specify cache directory
python -m src.web.pit_wall_server --year 2026 --round 1 --cache-dir /tmp/f1cache
```

## Architecture

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

**Two process modes coexist:**

| Mode | Start command | Data path |
|---|---|---|
| **Headless web** | `python -m src.web.pit_wall_server` | FastAPI + WS → React app |
| **Legacy desktop** | `python main.py` | PySide6 → Arcade → TCP 9999 |

The web server is a **superset** consumer — the desktop path and existing TCP insight windows remain untouched.

## API Reference

### REST Endpoints

| Method | Path | Returns |
|---|---|---|
| GET | `/api/session/status` | `{status, progress, message, year?, round?}` — poll during cold load |
| GET | `/api/seasons` | `{seasons: [2018..2026]}` |
| GET | `/api/seasons/{year}/rounds` | `[{round_number, event_name, date, country, ...}]` |
| POST | `/api/session/load` | `202 {ok, status:"loading"}` — non-blocking; poll `/api/session/status` |
| GET | `/api/session/summary` | Event info, drivers, total_laps |
| GET | `/api/session/geometry` | Centerline, DRS zones, sector boundaries, bbox |
| GET | `/api/session/race_control?since=<s>` | Race control messages |
| GET | `/api/session/results` | Best-effort classification |
| GET | `/api/session/gap_to_leader` | `{total_laps, drivers:[{code, gaps[], pit_laps[]}], sc_bands[]}` — per-lap gap-to-leader for the spaghetti chart panel |
| POST | `/api/playback/play` | `{ok:true}` |
| POST | `/api/playback/pause` | `{ok:true}` |
| POST | `/api/playback/seek` | Body: `{t: 0.42}` — fraction ∈ [0,1] |
| POST | `/api/playback/speed` | Body: `{speed: 2}` |
| POST | `/api/chat` | Body: `{message, context}` — rate-limited 1 req/2s/IP |

### WebSocket

Connect to `ws://localhost:8000/ws/telemetry`.

Message types received:

| `type` | When | Key fields |
|---|---|---|
| `loading` | Session not yet ready | `status`, `progress`, `message` |
| `snapshot` | Session loaded / client connects after ready | Full state: geometry, driver_meta, standings, race_control_history |
| `frame` | ~25–60 Hz during playback | `frame_index`, `t_seconds`, `lap`, `flag_state`, `standings`, `playback_speed`, `is_paused`, `weather`, `safety_car`, `new_rc_events` |

## Adding a New Panel

The frontend is bundler-free React (Babel in-browser transpile). Any new `.jsx` file in `project/src/` can access live data:

```jsx
// project/src/my_panel.jsx
function MyPanel() {
  const { frame, snapshot, playback, rc } = window.LIVE.useLive();

  if (!frame) return <div>Loading...</div>;

  return (
    <div>
      <div>Lap {frame.lap}/{frame.total_laps}</div>
      <div>Flag: {frame.flag_state}</div>
      <div>Speed: {playback.speed}x</div>
      {frame.standings.map(s => (
        <div key={s.code}>{s.pos}. {s.code} — {s.speed_kph} km/h</div>
      ))}
    </div>
  );
}
window.MyPanel = MyPanel;
```

Then add a `<script type="text/babel" src="src/my_panel.jsx"></script>` tag in `project/Pit Wall.html` and render `<MyPanel/>` where needed in `App.jsx`.

### Available Data Sources

| Source | How to access | Contents |
|---|---|---|
| `window.APEX` | Top-level const | `TEAMS`, `DRIVERS`, `CIRCUIT`, `SECTORS`, `DRS_ZONES`, `COMPOUNDS`, `computeStandings()`, `telemetryFor()` |
| `window.LIVE.useLive()` | React hook | `frame`, `snapshot`, `playback`, `rc`, `loading` |
| `window.APEX_CLIENT` | HTTP/WS client | `get(path)`, `post(path, body)`, `openSocket(onMsg)` |

## Keyboard Shortcuts

| Key | Action |
|---|---|
| Space | Play / Pause |
| ← / → | Seek backward / forward (small step) |
| Shift+← / Shift+→ | Seek backward / forward (large step) |
| ↑ / ↓ | Increase / decrease speed |
| 1 / 2 / 3 / 4 | Set speed to 0.5× / 1× / 2× / 4× |
| R | Restart (seek to 0) |
| D | Toggle DRS zones |
| L | Toggle driver labels |
| B | Toggle progress bars |

## File Map

```
src/web/                         # Python backend (FastAPI)
├── __init__.py
├── pit_wall_server.py           # Entry point, lifespan, CORS, static mount
├── session_manager.py           # FastF1 session load + cache
├── playback.py                  # Wall-clock playhead + frame builder
├── ws_hub.py                    # WebSocket connection manager
├── ws_routes.py                 # WS endpoint
├── http_routes.py               # REST endpoints
├── chat_bridge.py               # Headless engineer chat adapter
├── serialization.py             # NumPy/Pandas → JSON safety
├── flags.py                     # track_statuses → flag_state bisect
└── schemas.py                   # Pydantic v2 models

project/src/                     # Frontend (React over Babel)
├── apex_client.jsx              # HTTP + WS client
├── live_state.jsx               # WS subscriber (React context)
├── loading_gate.jsx             # Cold-load progress overlay
├── data.jsx                     # Live data shim (window.APEX)
├── App.jsx                      # Root component
├── IsoTrack.jsx                 # Isometric 3D track view
├── Controls.jsx                 # TopBar, Timeline, CameraControls
├── Leaderboard.jsx              # Classification panel
├── Telemetry.jsx                # DriverCard, CompareTraces, SectorTimes
└── Panels.jsx                   # StrategyStrip, GapViz, GapHistory, RaceFeed
```
