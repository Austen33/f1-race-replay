# APEX · Pit Wall — New Frontend

A browser-based F1 race engineer console built on top of the forked [4f4d/f1-race-replay](https://github.com/4f4d/f1-race-replay) Python telemetry pipeline. The original project shipped a **PySide6 + Arcade** desktop viewer; this fork adds a full **React** frontend (code-named **APEX Pitwall**) that runs in the browser, backed by a new FastAPI + WebSocket server. Both runtimes coexist — the legacy desktop path still works.

This document enumerates, in detail, **every feature the new frontend adds**.

---

## Table of Contents

1. [What's new at a glance](#whats-new-at-a-glance)
2. [Quick start](#quick-start)
3. [Architecture](#architecture)
4. [The Pit Wall UI](#the-pit-wall-ui)
5. [Panel system](#panel-system)
6. [Track rendering (IsoTrack)](#track-rendering-isotrack)
7. [Classification / leaderboard](#classification--leaderboard)
8. [Telemetry panels](#telemetry-panels)
9. [Strategy, gaps, race control](#strategy-gaps-race-control)
10. [Playback, timeline & camera](#playback-timeline--camera)
11. [Keyboard shortcuts](#keyboard-shortcuts)
12. [Theme & design system](#theme--design-system)
13. [Live data plumbing](#live-data-plumbing)
14. [Backend additions (src/web)](#backend-additions-srcweb)
15. [REST & WebSocket API](#rest--websocket-api)
16. [Engineer Chat + Bayesian tyre model](#engineer-chat--bayesian-tyre-model)
17. [Build & file map](#build--file-map)
18. [Extending the UI](#extending-the-ui)

---

## What's new at a glance

The upstream project had **no browser frontend**. This fork adds:

- A new [project/](project/) directory containing a **React 18** app bundled by **esbuild** into a single IIFE (`project/dist/bundle.js`), served at `http://localhost:8000/app/Pit%20Wall.html`.
- A new [src/web/](src/web/) FastAPI server that exposes the FastF1 pipeline over HTTP + WebSocket, in parallel with the legacy TCP-9999 insight-window stream.
- **9 dockable panels** with hide / collapse / maximize / pop-out-to-new-window behavior, persisted to `localStorage`.
- A **3D isometric SVG track** with a top-down toggle, tilt/rotate/zoom camera sliders, kerbs, pit lane, sector dividers, corner numbering, and a simulated Safety Car.
- Primary + secondary driver selection with **side-by-side compare traces** (SPD / THR / BRK / GEAR / RPM) and a live delta strip.
- A **race-engineer-styled HUD**: JetBrains Mono typography, flag-glow overlays, scanlines, pulsing live dot, sector-tinted progress bars.
- **Strategy strip**, **gap visualisation**, **sector times**, **driver cards**, and a **Race Control feed** with FIA message tagging.
- Coexistent [Engineer Chat](#engineer-chat--bayesian-tyre-model) AI window with live race context (Groq → Cerebras → Groq-8b fallback chain), 2026 season data, and Bayesian tyre-degradation modelling.

All commits since the initial fork point (`6f473f2`) are frontend or backend additions for this console — ~40 commits across `main`, `feat/map_overhaul`, `feat/ui-features`, and `feat/race_window`.

---

## Quick start

```bash
pip install -r requirements.txt
python -m src.web.pit_wall_server --year 2026 --round 1
```

Then open **[http://localhost:8000/app/Pit%20Wall.html](http://localhost:8000/app/Pit%20Wall.html)**.

A loading overlay tracks FastF1 cache hydration + telemetry computation. Once `status: "ready"` arrives on the WebSocket, the full console renders.

### CLI flags

| Flag | Default | Description |
|---|---|---|
| `--year` | 2026 | Championship year |
| `--round` | 1 | Round number (1-based) |
| `--session-type` | R | `R` race, `Q` qualifying, `SQ` sprint quali |
| `--host` | 127.0.0.1 | Bind address |
| `--port` | 8000 | Bind port |
| `--cache-dir` | cache/fastf1 | FastF1 HTTP cache directory |

### Building the frontend bundle

```bash
cd project
npm install
npm run build        # writes dist/bundle.js (minified IIFE)
npm run watch        # rebuild on change, with sourcemaps
```

The bundle loads React/ReactDOM from CDN (`unpkg.com`) as globals; only application code is bundled.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                   Python process (pit_wall_server.py)                │
│                                                                      │
│  FastF1 Cache ──► load_session ──► get_race_telemetry ──► frames     │
│         │                                   │                        │
│         │                                   ├─► TCP 9999 (unchanged) │
│         │                                   │   (existing Qt wins)   │
│         │                                   ▼                        │
│  FastAPI + Uvicorn (HTTP + WS) on port 8000                          │
│   REST /api/seasons, /api/session/*, /api/playback/*, /api/chat      │
│   WS   /ws/telemetry                                                 │
│   MOUNT /app → project/                                              │
└──────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
          http://localhost:8000/app/Pit%20Wall.html
```

**Two runtimes coexist:**

| Mode | Start command | Data path |
|---|---|---|
| **Headless web (NEW)** | `python -m src.web.pit_wall_server` | FastAPI + WS → React |
| **Legacy desktop** | `python main.py` | PySide6 → Arcade → TCP 9999 |

---

## The Pit Wall UI

The layout is a fixed three-rail grid sized to the viewport, with a persistent top bar and a persistent bottom timeline:

```
┌──────────────────────── TopBar (event / session / flag / weather / PANELS menu / live dot) ──┐
│ Left Rail (320)     │   Center (flex)                      │  Right Rail (360)              │
│                     │                                      │                                 │
│  CLASSIFICATION     │   CIRCUIT VIEW (IsoTrack)            │   PRIMARY DRIVER (card)         │
│                     │                                      │   COMPARE DRIVER (card)         │
│                     │                                      │   GAP VISUALIZATION             │
│                     ├──────────────────────────────────────┤                                 │
│                     │ STRATEGY │ COMPARE │ SECTORS │ FEED  │                                 │
└─────────────────────────────────── Timeline + transport + scrub + camera ────────────────────┘
```

**Global UI features:**

- **Flag-glow overlay** — the whole viewport tints yellow (SC/VSC), red, or green via CSS keyframe animations (`apex-flag-glow-yellow`, `apex-flag-glow-red`).
- **Scanline** — optional CRT-style scanline animation (`.scanline::after`, 8 s loop) for an on-TV-broadcast feel.
- **Panel-mount animation** — each panel fades/slides in on mount (`apex-panel-in`, 120 ms).
- **Row pulse** — the pinned leaderboard row flashes when crossing a sector boundary (`apex-row-pulse`, 450 ms).
- **Live dot** — animated pulsing green dot next to "TELEMETRY STREAM" in the top bar.
- **Edit mode** — parent-posted `__activate_edit_mode` message unlocks a Tweaks panel with camera presets (BROADCAST, TOP DOWN, LOW ANGLE, PADDOCK) and accent-color picker (red/orange/purple/green).
- **Custom scrollbars**, CSS-variable theming (`--bg`, `--red`, `--text`…), radial-gradient background.

---

## Panel system

Every panel lives inside a [PanelFrame](project/src/PanelFrame.jsx) that provides four window-management affordances:

| Button | Glyph | Action |
|---|---|---|
| Collapse | `▾` / `▸` | Shrink to a 28 px title bar; click to re-expand |
| Maximize | `⛶` / `▭` | Fullscreen overlay (92 % black + 4 px backdrop-blur); **Esc** to exit |
| Pop out | `↗` / `↙` | Open the panel in a separate `window.open()` popup; body hosts a React portal (`#apex-popout-root`). Stylesheets are cloned to the popup so the theme carries over. |
| Close | `✕` | Hide; re-enable via the **PANELS** menu in the top bar |

Buttons are **hover-gated** on hover-capable devices (fade in, 140 ms) and always visible on touch.

Layout is persisted to `localStorage` under `apex.panelLayout.v1` as `{ [panelId]: { visible, collapsed } }`.

The nine registered panels ([PanelRegistry.jsx](project/src/PanelRegistry.jsx)):

| ID | Title |
|---|---|
| `leaderboard` | CLASSIFICATION |
| `track` | CIRCUIT VIEW |
| `strategy` | STRATEGY |
| `compare` | COMPARE TRACES |
| `sectors` | SECTOR TIMES |
| `feed` | RACE CONTROL |
| `driverCard` | PRIMARY DRIVER |
| `driverCard2` | COMPARE DRIVER |
| `gap` | GAP VISUALIZATION |

---

## Track rendering (IsoTrack)

[IsoTrack.jsx](project/src/IsoTrack.jsx) (663 lines) is a bespoke SVG renderer with a CSS-3D-transformed container. It replaces the upstream Arcade track renderer.

**View modes:**

- **ISO (3D)** — CSS `perspective: 1800px`, `rotateX` (tilt, 0–85°), `rotateZ` (spin, ±180°). Default preset: tilt 62°, rotation −18°, zoom 100 %.
- **TOP (2D)** — flattens tilt to 0, keeps rotation. Adds **red/white kerb pips** at high-curvature corners and a directional heading arrow on each car.

Zoom is **split**: two-thirds via CSS scale (framing), one-third via the SVG viewBox (so vector geometry re-rasterizes crisply at every zoom level, instead of pixelating).

**Track geometry:**

- **Outline** — centripetal Catmull-Rom spline (α = 0.5) through the circuit points, chosen specifically to avoid self-intersection at hairpins.
- **Shoulder/runoff** — scaled outline at 1.012× for a cheap width effect.
- **Racing line** — dashed subtle line down the centerline.
- **Pit lane** — offset parallel track from ~55 % onward, darker asphalt, dashed centerline.
- **Sectors** — three coloured markers (S1 red, S2 yellow, S3 cyan) perpendicular to the track at boundary indices.
- **Start/Finish** — checkered band (8×8 pattern), red GRID line with glow, direction arrow, "S/F" label.
- **Corner labels** — curvature-detected (|Δangle| > 0.35) with 14-pt non-maximum suppression, up to 14 circled labels ("T1", "T2" …) with connector lines and a Gaussian drop-shadow filter (`cornerShadow`). Rendered in a flat, non-tilted overlay projected into screen space.

**Driver cars:**

- Positions bucketed along 6-point track intervals with **orthogonal spread** so overlapping cars fan out laterally instead of stacking.
- Each car: team-coloured fill (r = 11×scale), position number centered in white.
- **Pinned** driver: dashed red outline ring (r = 16, 4–3 dash).
- **Secondary** (compare) driver: dashed cyan outline ring.
- Hover: 22 px semi-transparent halo.
- **Speed halo** — faint trailing circle with opacity ∝ speed/350.
- **"P" label** if in pit; greyed (opacity 0.3) if DNF.
- **Heading arrow** in top-down mode, rotated to the instantaneous track tangent.
- Optional **driver-code labels** in bordered boxes, offset outward from the car; toggle with `L`.

**Safety car:**

- Golden (#FFB800) glowing circle at the projected world position.
- Pulsing radius `22 + sin(pulse) × 6`.
- Phase label: `SAFETY CAR` / `SC DEPLOYING` / `SC IN` with phase-dependent alpha.

**Interaction:**

- Click a car → pin primary.
- Shift-click → toggle secondary driver (used by the compare panels).

---

## Classification / leaderboard

[Leaderboard.jsx](project/src/Leaderboard.jsx) is a dense engineering-style timing tower.

Columns (per row):

| Col | Content |
|---|---|
| Position | 2-digit left-padded |
| Team marker | 2 px vertical team-colour bar (accurate 2026 colours) |
| Driver | Code (bold) + team name (dim) below |
| Sector bar | 2 px fill, colour = active sector (S1 red / S2 yellow / S3 cyan), glow when pinned |
| Gap | `LEADER` or `+MM:SS.sss` |
| Interval | `+N.NNN` or `—` if leader |
| Last lap | `M:SS.sss` — **purple** = session fastest, **green** = PB, **yellow** = within 0.2 s of PB, white otherwise |
| Tyre pip | SVG circle in compound colour (S/M/H/I/W) with a tiny red dot overlaid when in pit |

**Selection highlights:**

- Pinned row — hot-red left border + horizontal gradient (12 % → 0 %).
- Secondary row — cool-cyan left border + gradient.
- Sector-transition pulse (`apex-row-pulse`) flashes the pinned row.

DNF drivers are dimmed and show `DNF` instead of tyre/gap details.

---

## Telemetry panels

Three panels in [Telemetry.jsx](project/src/Telemetry.jsx).

### DriverCard (primary + compare)

- Driver-number badge in team colour, code (bold), full name (faint), country code top-right.
- 2 px hot/cool accent strip at the top (hot = pinned, cool = secondary).
- Two big readouts with glow: **SPEED** (kph) and **GEAR**.
- Throttle / Brake bars with 25/50/75 % ticks, glow under the filled portion, percentage readout.
- Micro-stats row: **RPM** (comma-grouped), **DRS** (OPEN green / CLSD gray), **TYRE** (compound letter + laps on it).
- Empty state for the compare card: dashed-border placeholder reading `SHIFT + CLICK DRIVER TO COMPARE`.

### CompareTraces

Side-by-side lap telemetry overlay.

- **5 channels**: SPD · THR · BRK · GEAR · RPM (button row top-left).
- Dual traces — pinned (hot red) vs secondary (cool cyan).
- **Interactive playhead**: vertical dashed line at the current track fraction; traces are clipped to only reveal up to the playhead, so even a fully-fetched lap animates "live" as time advances. Leading-edge dots mark the playhead tip.
- Y-axis min/max labelled, grid lines at 0/25/50/75/100 %.
- Sector dividers (S1/S2/S3) drawn from real circuit `sector_boundaries_m` (with a 1/3–2/3 fallback).
- **Delta strip** below the trace: when two drivers are selected, shows `speed_a − speed_b` as a continuous line; centerline = zero, ±range shown in footer.
- `WAIT` badge while the server trace endpoint resolves.

### SectorTimes

Compact table with columns `Driver · S1 · S2 · S3 · Total`.

Rows: primary (hot), secondary (cool), session best (if known, purple).

Cell colouring: **purple** when both session-best *and* personal best, **green** when personal best, white otherwise.

---

## Strategy, gaps, race control

From [Panels.jsx](project/src/Panels.jsx).

### StrategyStrip

Tyre-strategy visualisation for the top 10 drivers.

- One horizontal row per driver: position · team colour · code · stint bar.
- Stints coloured by compound (S red, M yellow, H white, I green, W blue).
- Stint opacity by time: completed laps 0.55, current lap 0.85, future laps 0.25.
- **Pit stops** — yellow vertical ticks (± 3 px).
- **Current-lap marker** — white vertical line.

### GapViz

Gap-to-leader "spider". Per row: driver code · proportional bar · numeric gap. Bar in team colour; pinned driver highlighted in hot red.

### RaceFeed

FIA race control messages with **tagged badges**:

| Tag | Colour | Meaning |
|---|---|---|
| SC | yellow | Safety car deployment |
| FLAG | red-orange | Yellow/red flag |
| DRS | red-orange | DRS enabled/disabled |
| INFO | subtle gray | Everything else |

Messages are time-stamped `MM:SS.sss`, newest at top, binary-searched against the current playback time so seeking backward hides future messages.

---

## Playback, timeline & camera

[Controls.jsx](project/src/Controls.jsx) houses the TopBar, the bottom Timeline, and the floating CameraControls.

### TopBar

- **Left**: `APEX · PITWALL` logo + event (Year · R# · Name) + session type + circuit name + length.
- **Center**: Flag badge (GREEN / YELLOW / RED FLAG / SAFETY CAR / VIRTUAL SC) + `LAP XX/YY` + clock (HH:MM:SS) + AIR / TRACK / HUMIDITY temps.
- **Right**: PANELS dropdown (check-box list of the 9 panels) + pulsing green live dot + "TELEMETRY STREAM" label.

### Timeline

- **Transport**: `◀◀` (back 2 %, shift 5 %) · Play/Pause · `▶▶` (forward 2 %, shift 5 %).
- **Speed buttons**: 0.5× · 1× · 2× · 4× (selected = hot-red bg).
- **Scrub track** (42 px tall):
  - Lap tick markers every lap (major ticks every 10 laps).
  - Sector-zone shading.
  - **Safety-car zones** highlighted with yellow borders and an "SC" label.
  - Playhead = 2 px line + triangle pointer, glowing red.
  - Progress fill glows with accent colour.
- **LAP XX/YY** counter bottom-right.

### CameraControls

Top-right floating overlay, collapsible with `C`.

- **View mode** — segmented toggle `3D [D]` / `TOP [M]`.
- **TILT** slider — 0–85° (disabled in TOP mode).
- **ROT** slider — ±180°.
- **ZOOM** slider — 50 %–400 %.
- **LABELS** toggle — driver codes on/off (`L`).
- **HIDE [C]** button (collapse) and **RESET** (back to broadcast preset).

Camera state is client-local; presets (when edit mode is active) include BROADCAST, TOP DOWN, LOW ANGLE, PADDOCK.

---

## Keyboard shortcuts

From [hotkeyHandler.js](project/src/hotkeyHandler.js) (ref-based to avoid stale closures; suppressed when an `<input>` or `<textarea>` has focus).

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `←` / `→` | Seek ±1 % (hold `Shift` for ±5 %) |
| `↑` / `↓` | Speed up / down through `[0.5, 1, 2, 4]` |
| `1` / `2` / `3` / `4` | Set speed directly |
| `R` | Restart (seek to 0) |
| `L` | Toggle driver labels |
| `M` | Toggle view mode (ISO ↔ TOP) |
| `D` | Force ISO (3D) view |
| `C` | Collapse / expand camera controls |
| `Esc` | Exit panel maximize |

DRS and progress-bar toggles from the original app were intentionally **removed** for 2026 (DRS is abolished under new regs, replaced by manual override — MOM).

---

## Theme & design system

Centralised in [theme.js](project/src/theme.js). All colours, spacing, typography, and motion durations are referenced from this module; any new panel inherits the look automatically.

**Accent palette:**

| Token | Hex | Use |
|---|---|---|
| `hot` | #FF1E00 | Primary accent / pinned driver |
| `cool` | #00D9FF | Secondary / compare driver |
| `good` | #1EFF6A | Personal-best / positive |
| `warn` | #FFD93A | S2 / caution |
| `caution` | #FFB800 | Safety car |
| `purple` | #C15AFF | Session best |

**Surfaces** layer from `surface` → `surface2` → `surface3` → `surfaceFlat`, each a dark translucent gradient. Borders are 1 px rgba-white at 4–6 %, with `borderHot` and `borderCool` variants for highlighted states.

**Typography** — JetBrains Mono throughout. Size scale: `xs 9` / `sm 10` / `md 12` / `lg 14` / `xl 24`. Letter-spacing scale: `tight 0.02em` → `wide 0.2em`. Body copy (Geist) is set on the `<body>` for non-monospace content.

**Motion scale** — `micro 60 ms`, `short 120 ms`, `medium 200 ms`. Panel mounts, sector-bar fills, flag glows, and pulse animations all reference these.

---

## Live data plumbing

Three globals wire the app to the backend:

| Global | Module | Contents |
|---|---|---|
| `window.APEX` | [data.jsx](project/src/data.jsx) | `TEAMS`, `DRIVERS`, `CIRCUIT`, `SECTORS`, `COMPOUNDS`, `computeStandings()`, `telemetryFor()`, `lapTrace()`, `fetchLapTrace()`, `getSessionBest()`, `getStints()`, `getPitStops()` |
| `window.LIVE.useLive()` | [live_state.jsx](project/src/live_state.jsx) | React hook → `{ frame, snapshot, playback, rc, loading }` |
| `window.APEX_CLIENT` | [apex_client.jsx](project/src/apex_client.jsx) | `get()`, `post()`, `openSocket()` (WS with exponential-backoff reconnect, capped at 10 s) |

**Loading gate** ([loading_gate.jsx](project/src/loading_gate.jsx)) shows a dark 72 % overlay with a 320 px red progress bar while FastF1 hydrates the session. It waits on **both** an `APEX_DATA_READY` promise *and* the WS `loading: { status: "ready" }` message; falls back to polling `/api/session/status` every 1 s if the socket is slow.

**Telemetry accumulator** — `window.__LAP_TELEMETRY` buckets live frames by driver/lap so that the CompareTraces panel can render partial current-lap data before the server endpoint returns.

**Trace caching** — server-fetched traces (full lap, accurate) are preferred, with in-flight dedup; the live accumulator is a fallback. All traces are resampled to 120 uniform points for rendering.

---

## Backend additions (src/web)

New package under [src/web/](src/web/):

| File | Role |
|---|---|
| `pit_wall_server.py` | FastAPI + Uvicorn entry point; argparse; static mount at `/app` → `project/` |
| `session_manager.py` | FastF1 session loader; caches processed telemetry in-proc; exposes loading state |
| `playback.py` | Wall-clock playhead (25 Hz internal, ~60 Hz WS push cap); frame builder |
| `ws_hub.py` | WebSocket connection manager and broadcaster |
| `ws_routes.py` | `/ws/telemetry` endpoint |
| `http_routes.py` | REST endpoints |
| `chat_bridge.py` | Headless adapter for the Engineer Chat (Groq → Cerebras → Groq-8b fallback) |
| `serialization.py` | NumPy / Pandas → JSON-safe conversion via ORJSONResponse |
| `flags.py` | `track_statuses` → `flag_state` bisect helper |
| `schemas.py` | Pydantic v2 models |

This is a **superset** of the existing data path — the TCP-9999 stream used by the PySide6 insight windows is untouched, so both the desktop Arcade viewer and the browser Pit Wall can run against the same FastF1 session.

---

## REST & WebSocket API

### REST

| Method | Path | Returns |
|---|---|---|
| GET | `/api/seasons` | `{seasons: [2018..2026]}` |
| GET | `/api/seasons/{year}/rounds` | Race calendar |
| POST | `/api/session/load` | `202 { ok, status: "loading" }` (non-blocking) |
| GET | `/api/session/status` | `{ status, progress, message, year?, round? }` |
| GET | `/api/session/summary` | Event info, drivers, total laps |
| GET | `/api/session/geometry` | Centerline, DRS zones, sector boundaries, bbox |
| GET | `/api/session/race_control?since=<s>` | Race-control messages |
| GET | `/api/session/results` | Best-effort classification |
| GET | `/api/session/lap_telemetry/{code}/{lap}` | Per-driver lap telemetry (added in `2ecda11`) |
| POST | `/api/playback/play` | `{ ok: true }` |
| POST | `/api/playback/pause` | `{ ok: true }` |
| POST | `/api/playback/seek` | Body `{ t: 0.42 }` (fraction) |
| POST | `/api/playback/speed` | Body `{ speed: 0.5\|1\|2\|4 }` |
| POST | `/api/chat` | Engineer Chat; rate-limited 1 req / 2 s / IP |

### WebSocket `/ws/telemetry`

| `type` | When | Key fields |
|---|---|---|
| `loading` | Before session is ready | `status`, `progress`, `message` |
| `snapshot` | On ready / on reconnect | Full state: geometry, driver_meta, standings, race_control_history, session_best, stints, pit_stops |
| `frame` | 25–60 Hz during playback | `frame_index`, `t_seconds`, `lap`, `flag_state`, `standings`, `playback_speed`, `is_paused`, `weather`, `safety_car`, `new_rc_events` |

---

## Engineer Chat + Bayesian tyre model

Introduced at the initial fork commit and hardened across April 2026. Preserved and integrated with the new frontend through `chat_bridge.py` and `POST /api/chat`.

**Engineer Chat** ([src/insights/engineer_chat_window.py](src/insights/engineer_chat_window.py)):

- Live race context injected into every message (tyre age, stint laps, pit stops, flag state).
- **Provider fallback chain**: Groq (primary) → Cerebras (`qwen-3-235b`) → Groq-8b.
- Hard 1,500-token cap per request.
- Race context compacted from ~7,000 to ~200 tokens.
- Search sources: Tavily (F1-domain-filtered), Wikipedia, OpenF1 API (with a 10-minute grid cache).
- Keyword-driven routing between "latest/news" vs "explain/technical" queries.
- Mandatory Rule-0 opening format in system prompt.
- Lazy Cerebras import to avoid hard dependency at startup.

**2026 season data** ([src/data/f1_season_data.py](src/data/)): 22 drivers with ages and car numbers, 11 teams with principals and power units, 24-race calendar, new 2026 tech regs (50/50 ICE/EV split, active aero, MOM replacing DRS), 2027 provisional driver list.

**Bayesian tyre-degradation model** ([src/bayesian_tyre_model.py](src/bayesian_tyre_model.py)): state-space degradation model covering SLICK / INTER / WET compounds with track-abrasion, fuel-effect, warmup, and condition-mismatch penalties. Drives the leaderboard tyre displays and telemetry panels through [src/tyre_degradation_integration.py](src/tyre_degradation_integration.py).

---

## Build & file map

```
project/                                # NEW — React frontend
├── Pit Wall.html                       # HTML entry; loads React from CDN + dist/bundle.js
├── build.mjs                           # esbuild: src/index.jsx → dist/bundle.js (IIFE)
├── package.json                        # build / watch scripts
├── dist/bundle.js                      # compiled output
└── src/
    ├── index.jsx                       # Module load order; window.XXX exports
    ├── theme.js                        # Design tokens
    ├── apex_client.jsx                 # HTTP + WS client
    ├── live_state.jsx                  # WS subscriber (React context)
    ├── loading_gate.jsx                # Cold-load progress overlay
    ├── data.jsx                        # window.APEX live-data shim
    ├── App.jsx                         # Root component; rail grid; state
    ├── IsoTrack.jsx                    # 3D/2D SVG track, cars, safety car
    ├── Leaderboard.jsx                 # Classification panel
    ├── Telemetry.jsx                   # DriverCard, CompareTraces, SectorTimes
    ├── Panels.jsx                      # StrategyStrip, GapViz, RaceFeed
    ├── PanelRegistry.jsx               # Panel ID ↔ title table
    ├── PanelFrame.jsx                  # Collapse / maximize / popout chrome
    ├── Controls.jsx                    # TopBar, Timeline, CameraControls
    ├── hotkeyHandler.js                # Keyboard shortcuts
    └── App.test.jsx                    # Tests

src/web/                                # NEW — FastAPI backend
├── pit_wall_server.py                  # Entry + static mount
├── session_manager.py                  # FastF1 loader + cache
├── playback.py                         # Playhead + frame builder
├── ws_hub.py                           # WS connection manager
├── ws_routes.py                        # /ws/telemetry
├── http_routes.py                      # REST endpoints
├── chat_bridge.py                      # Engineer Chat adapter
├── serialization.py                    # NumPy/Pandas → JSON
├── flags.py                            # Track status → flag state
└── schemas.py                          # Pydantic v2 models
```

**Build specifics** ([project/build.mjs](project/build.mjs)):

- Entry `src/index.jsx`, output `dist/bundle.js`, format **IIFE** (no module exports).
- JSX transformed via `React.createElement` / `React.Fragment`.
- Targets: Chrome 90+, Firefox 90+, Safari 15+.
- React and ReactDOM are **not bundled** — loaded as CDN globals from `unpkg.com/react@18.3.1` and `unpkg.com/react-dom@18.3.1`.
- All modules write their exports onto `window.XXX` so the IIFE just needs side-effects — no export reconciliation.
- Minify on for production, sourcemaps on for `--watch`.

---

## Extending the UI

Drop a new `.jsx` file into `project/src/`, grab live data from `window.LIVE.useLive()`, and register a panel entry in `PanelRegistry.jsx`:

```jsx
function MyPanel() {
  const { frame, playback } = window.LIVE.useLive();
  if (!frame) return <div>Loading…</div>;
  return (
    <div>
      <div>Lap {frame.lap}/{frame.total_laps} · {playback.speed}×</div>
      {frame.standings.map(s => (
        <div key={s.code}>{s.pos}. {s.code} — {s.speed_kph} km/h</div>
      ))}
    </div>
  );
}
window.MyPanel = MyPanel;
```

Add it to the registry, wrap it in a `<PanelFrame>` inside `App.jsx`, and it inherits hide / collapse / maximize / popout / localStorage persistence automatically.

---

*Last updated 2026-04-22 — fork `Austen33/f1-race-replay`, branch `feat/race_window`.*
