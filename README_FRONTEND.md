# APEX · Pit Wall Frontend

A browser-based F1 race engineer console built on top of the forked [4f4d/f1-race-replay](https://github.com/4f4d/f1-race-replay) Python telemetry pipeline. The original project shipped a **PySide6 + Arcade** desktop viewer; this fork includes a full **React** frontend (code-named **APEX Pitwall**) that runs in the browser, backed by a FastAPI + WebSocket server. Both runtimes coexist, and the legacy desktop path remains available.

This document is a detailed technical guide to the frontend runtime, rendering stack, API contract, and extension points.

---

## Table of Contents

1. [Feature overview](#feature-overview)
2. [Quick start](#quick-start)
3. [Architecture](#architecture)
4. [The Pit Wall UI](#the-pit-wall-ui)
5. [Panel system](#panel-system)
6. [Track rendering (Track3D + IsoTrack)](#track-rendering-track3d--isotrack)
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

## Feature overview

The upstream project had no browser frontend. This fork provides:

- A new [project/](project/) directory containing a **React 18** app bundled by **esbuild** into a single IIFE (`project/dist/bundle.js`), served at `http://localhost:8000/app/Pit%20Wall.html`.
- A new [src/web/](src/web/) FastAPI server that exposes the FastF1 pipeline over HTTP + WebSocket, in parallel with the legacy TCP-9999 insight-window stream.
- A deterministic Arrow web cache under `computed_data/web/v1/{year}_{round}_{session_type}.arrow` with sidecar metadata validation (`schema_version >= 3`, `cache_profile: "web-replay"`, exact `cache_key`).
- Cache-first warm startup semantics: valid web cache hydrates runtime state without creating a live FastF1 session object.
- Cold-cache build semantics: full FastF1 session loading (telemetry/weather/messages) generates deterministic cache artifacts, then runtime state hydrates from cache.
- **9 dockable panels** with hide / collapse / maximize / pop-out-to-new-window behavior, persisted to `localStorage`.
- A **dual track renderer**: default **Three.js WebGL** scene ([Track3D.jsx](project/src/Track3D.jsx)) plus legacy **SVG IsoTrack** fallback.
- WebGL-specific camera modes: **orbit**, **follow/chase**, and **POV**; plus retained **TOP** and **SVG** modes.
- A cockpit-mounted **steering-wheel HUD** in POV: live gear / speed / brake / throttle / MOM / tyre / lap / flag-state telemetry rendered directly onto the pinned driver's wheel, with a live tuning panel for placement and emissive controls.
- Updated GLB car assets with tuned cockpit framing, flat team-colour livery handling, and preserved non-livery materials so body colours stay readable without washing out carbon, chrome, or wheel detail.
- **Scalable quality presets** (`low`/`med`/`high`) for WebGL rendering to trade visual fidelity vs performance.
- Binary WebSocket frame transport (`orjson` bytes server-side, `arraybuffer` client-side decode) to minimize repeated serialization overhead.
- Playback-side memoization for frame/standings calculations and lap-telemetry cache pathing via Arrow `lap_trace_index`.
- Standings continuity guards and out-of-play handling so retired/incident drivers do not produce invalid interval artifacts.
- Primary + secondary driver selection with **side-by-side compare traces** (SPD / THR / BRK / GEAR / RPM) and a live delta strip.
- A **race-engineer-styled HUD**: JetBrains Mono typography, flag-glow overlays, scanlines, pulsing live dot, sector-tinted progress bars.
- **Strategy strip**, **gap visualisation**, **sector times**, **driver cards**, and a **Race Control feed** with FIA message tagging.
- Coexistent [Engineer Chat](#engineer-chat--bayesian-tyre-model) AI window with live race context (Groq → Cerebras → Groq-8b fallback chain), 2026 season data, and Bayesian tyre-degradation modelling.

---

## Quick start

```bash
pip install -r requirements.txt
cd project
npm install
npm run build
cd ..
python -m src.web.pit_wall_server --year 2026 --round 1
```

Then open **[http://localhost:8000/app/Pit%20Wall.html](http://localhost:8000/app/Pit%20Wall.html)**.

A loading overlay tracks session startup state. Warm starts hydrate replay state from deterministic web cache only; cold starts perform full FastF1 load/build, then hydrate from cache. Once `status: "ready"` arrives on the WebSocket, the full console renders.

`npm install` is required once for the frontend bundle. After that, rerun `npm run build` whenever you change files under `project/src/`.

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
│  Warm path: computed_data/web/v1/{year}_{round}_{session}.arrow      │
│             + .meta.json  ──► hydrate replay state (cache-only)      │
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

If the deterministic web cache is missing or invalid, startup performs a rebuild into `computed_data/web/v1/` before entering ready state.

### Web cache-first lifecycle

`SessionManager.load(year, round, session_type)` has explicit warm/cold branches:

1. Resolve deterministic path: `computed_data/web/v1/{year}_{round}_{session_type}.arrow`
2. Validate sidecar metadata (`.meta.json`) against:
   - `schema_version >= 3`
   - `cache_profile == "web-replay"`
   - exact `cache_key` match
3. Warm path:
   - open `RaceHandle`
   - hydrate runtime state from Arrow + sidecar
   - no `load_session(...)` call
4. Cold path:
   - `load_session(...)` + full telemetry/weather/messages load
   - build deterministic Arrow + sidecar
   - reopen via `RaceHandle` and hydrate

Startup/loading state messages:

- `Checking web cache`
- `Building web cache`
- `Hydrating replay state`
- `Ready`

In the web runtime, `loaded["session"]` is intentionally nullable and warm-hydrated state sets it to `None`. API/WS payload shapes remain stable for frontend consumers.

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

## Track rendering (Track3D + IsoTrack)

[Track3D.jsx](project/src/Track3D.jsx) is the primary renderer for the circuit panel (`viewMode: webgl/follow/pov`). It adds a Three.js scene with dynamic lighting/post, 3D car/safety-car models, weather-aware material shifts, and camera-mode-specific UX.

[IsoTrack.jsx](project/src/IsoTrack.jsx) remains available as the legacy SVG renderer (`viewMode: iso/top`) and is still useful as a lightweight fallback/debug view.

### Track3D (default WebGL path)

- Three.js renderer with ACES tone mapping, post-processing chain (bloom + vignette + output), and quality presets.
- 3D track layers and surface treatment (track, runoff, kerbs, grass/verges, barriers, gravel pockets) with weather-aware color/material modulation.
- GLB-based **driver car model** and **safety car model**, including tuned fit/orientation on the 3D curve plus flat team-colour livery handling that keeps wheel, carbon, chrome, and cockpit materials readable.
- Camera modes: orbit, follow/chase, and POV; speed-reactive vignette/FOV behavior in dynamic modes.
- In-scene overlays: floating labels, selection/compare halos, follow-cam HUD, and steering-wheel POV HUD integration.
- Steering-wheel live HUD: renders gear, speed, throttle, brake, MOM state, tyre/lap info, last-lap tagging, and flag state onto the pinned driver's cockpit wheel; SC / VSC states are mirrored into the wheel display and the pit-limiter takeover only appears during genuine pit-lane segments.
- Live wheel-HUD tuning panel: `W` toggles an on-screen control surface for quad placement, UV flipping, scale, and emissive intensity; tuned defaults live in [`project/src/track3d/constants.js`](project/src/track3d/constants.js).
- Robust model fallback path: if GLB assets fail, primitive marker meshes are substituted so rendering remains functional.
- Status-aware labels: `RET` and `ACC` badges are rendered in overlays, and retired/incident cars are hidden from track labels to reduce clutter.
- Smoothing and interpolation:
  - data-path interpolation in `data.jsx`/`live_state.jsx`
  - per-car visual smoothing in Track3D
  - seek-safe buffer resets when playback state/time discontinuities are detected
- Track3D includes zero-allocation hot-path cleanups, SMAA edge anti-aliasing, race-start seam/orientation fixes, and wet-conditions visibility adjustments.

### IsoTrack (legacy SVG path)

Legacy notes below apply to the SVG renderer path:

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

- **View mode** — segmented toggle `GL` / `SVG` / `CHASE` / `POV` / `TOP`.
- **QUALITY** selector (`LOW` / `MED` / `HIGH`) for WebGL-based modes (`GL`, `CHASE`, `POV`).
- **TILT / ROT / ZOOM** sliders for legacy SVG modes (`SVG`, `TOP`).
- **LABELS** toggle — driver codes on/off (`L`).
- **HIDE [C]** button (collapse) and **RESET** (back to broadcast preset).

In `POV`, the old floating HUD is intentionally replaced by the steering-wheel display. `H` affects the follow-cam overlay, while `W` opens the wheel-HUD tuning panel.

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
| `M` | Toggle view mode (`TOP` ↔ `WEBGL`) |
| `D` | Force WebGL (`WEBGL`) view |
| `F` | Toggle chase camera (`FOLLOW` ↔ `WEBGL`) |
| `H` | Toggle follow-cam HUD visibility |
| `W` | Toggle the wheel-HUD tuning panel (debug) |
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
| `session_manager.py` | Cache-first web loader; warm loads hydrate from deterministic Arrow cache, cold loads rebuild via FastF1 |
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
    ├── Track3D.jsx                     # Three.js scene orchestration, camera logic, animation loop
    ├── IsoTrack.jsx                    # Legacy 3D/2D SVG renderer (fallback modes)
    ├── Leaderboard.jsx                 # Classification panel
    ├── Telemetry.jsx                   # DriverCard, CompareTraces, SectorTimes
    ├── Panels.jsx                      # StrategyStrip, GapViz, RaceFeed
    ├── PanelRegistry.jsx               # Panel ID ↔ title table
    ├── PanelFrame.jsx                  # Collapse / maximize / popout chrome
    ├── Controls.jsx                    # TopBar, Timeline, CameraControls
    ├── hotkeyHandler.js                # Keyboard shortcuts
    ├── track3d/
    │   ├── atmosphere.js               # Sky, rain, trackside set-dressing, time-of-day helpers
    │   ├── cars.js                     # GLB loading, marker construction, material/livery handling
    │   ├── constants.js                # Wheel-HUD tuning defaults
    │   ├── geometry.js                 # Track ribbons, gates, terrain, and helper geometry
    │   ├── hud.js                      # Follow HUD + steering-wheel HUD + tuning panel
    │   ├── index.js                    # Track3D helper barrel exports
    │   ├── labels.js                   # DOM label layer helpers
    │   ├── textures.js                 # Procedural textures + environment cache
    │   └── wheelHudAttachment.js       # Steering-wheel HUD attach / detach / reapply logic
    └── App.test.jsx                    # Tests

src/web/                                # NEW — FastAPI backend
├── pit_wall_server.py                  # Entry + static mount
├── session_manager.py                  # Cache-first web loader + deterministic cache builder
├── playback.py                         # Playhead + frame builder
├── ws_hub.py                           # WS connection manager
├── ws_routes.py                        # /ws/telemetry
├── http_routes.py                      # REST endpoints
├── chat_bridge.py                      # Engineer Chat adapter
├── serialization.py                    # NumPy/Pandas → JSON
├── flags.py                            # Track status → flag state
└── schemas.py                          # Pydantic v2 models

car_model.glb                           # 3D F1 car asset used by Track3D
safety_car.glb                          # 3D safety car asset used by Track3D
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
