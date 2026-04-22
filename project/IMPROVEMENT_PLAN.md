# Pit Wall — Tier 1 + Tier 2 + Bug-Fix Implementation Plan

Scope: fix all confirmed bugs, implement Tier 1 (RC markers on timeline, hover tooltip on IsoTrack, weather/flag/SC wiring), implement Tier 2 (pit window indicator, gap-to-leader sparkline, DRS chevron, sector-dominance tri-bar), and overhaul on-track driver rendering for visibility.

**Non-goals.** No CSS palette changes. No layout grid changes. No Phase-3 features (battle detector, overtake scrubber).

**Touch list.**
- Backend: [src/web/playback.py](../src/web/playback.py), [src/web/session_manager.py](../src/web/session_manager.py).
- Frontend: [project/src/data.jsx](./src/data.jsx), [project/src/App.jsx](./src/App.jsx), [project/src/IsoTrack.jsx](./src/IsoTrack.jsx), [project/src/Leaderboard.jsx](./src/Leaderboard.jsx), [project/src/Telemetry.jsx](./src/Telemetry.jsx), [project/src/Panels.jsx](./src/Panels.jsx), [project/src/Controls.jsx](./src/Controls.jsx).

Do the phases in order. Each ends with a concrete verification.

---

## Phase 0 — Backend: one-pass FastF1 extension

Goal: enrich `session_manager.load` and `standings_from_frame` so the frontend never has to fabricate data again. One structural change, reused by most Tier 1/2 features.

### 0.1 Extend `_precompute_lap_times` to return sector splits + stint/pit data

File: [src/web/session_manager.py:214](../src/web/session_manager.py#L214)

Replace the current `_precompute_lap_times` with a richer builder that returns, per driver code:

```python
{
  "laps": {lap_no: {
      "lap_time_s": float | None,
      "s1_s": float | None, "s2_s": float | None, "s3_s": float | None,
      "is_personal_best": bool,
      "compound": "SOFT"|"MEDIUM"|"HARD"|"INTERMEDIATE"|"WET",
      "tyre_life": int,
      "stint": int,
      "pit_in": bool,     # this lap ended with a pit stop
      "pit_out": bool,    # this lap started after a pit stop
      "fresh_tyre": bool,
      "track_status": str,
      "deleted": bool,
  }},
  "stints": [{"stint": int, "compound": str, "start_lap": int, "end_lap": int, "laps": int}],
  "pit_stops": [{"lap": int, "duration_s": float | None}],
}
```

Columns used (all native `session.laps`): `Driver, LapNumber, LapTime, Sector1Time, Sector2Time, Sector3Time, IsPersonalBest, Compound, TyreLife, Stint, PitInTime, PitOutTime, FreshTyre, TrackStatus, Deleted`. Use `.total_seconds()` on timedelta-typed columns; guard for `None`/`NaT`.

Also compute and return session-wide best sectors:
```python
session_best = {"s1_s": float | None, "s2_s": float | None, "s3_s": float | None, "lap_s": float | None}
```

### 0.2 Return the richer shape from `SessionManager.load`

File: [src/web/session_manager.py:37](../src/web/session_manager.py#L37)

Replace `"lap_times": _precompute_lap_times(session),` with:
```python
"lap_data": _precompute_lap_data(session),   # renamed from lap_times
"session_best": _compute_session_best(session),
```

Keep `fastest_qual_lap_s` as-is (used below in snapshot).

### 0.3 Populate real `in_pit` and sector fields on standings

File: [src/web/playback.py:294-332](../src/web/playback.py#L294-L332)

In `standings_from_frame`:

1. Replace `lap_times = loaded.get("lap_times", {})` with `lap_data = loaded.get("lap_data", {})` and look up `lap_data[code]["laps"]`.
2. Derive `last_lap_s`, `best_lap_s` as today, but also emit:
   - `last_s1_s / last_s2_s / last_s3_s` from the previous lap's sector splits.
   - `personal_best_lap_s` (min of that driver's lap times).
   - `personal_best_s1/2/3_s` (min of that driver's sector splits).
   - `stint` (current stint number from current lap row, fallback 1).
   - `laps_on_tyre` (already present as `tyre_age_laps` — keep; verify against `TyreLife`).
3. **Real `in_pit`.** A driver is in-pit for frames where the current lap is marked `PitInTime` or `PitOutTime`, OR their projected position is inside the pit-lane geometry window, OR the `get_race_telemetry` frame already has `in_pit=True`. Prefer the frame flag if `f1_data.py` sets it; otherwise fall back to: "current lap has non-null `PitInTime` AND the driver's lap progress fraction > 0.9" OR "current lap has non-null `PitOutTime` AND fraction < 0.1". Document which branch is live in a single-line comment above the logic.
4. Status becomes `"PIT"` when `in_pit`, `"OUT"` if the driver has no frame data at the current time (i.e. not in `frame["drivers"]`), else `"RUN"`. Today OUT is never emitted — fix by iterating over all known driver codes (from `driver_meta`), not just those present in `frame["drivers"]`, and emitting a placeholder standings entry with `status="OUT"` so the Leaderboard and IsoTrack can dim them consistently.

### 0.4 Add session-wide best sectors + fastest-qual to the snapshot

File: [src/web/playback.py:212-229](../src/web/playback.py#L212-L229) (`build_snapshot`)

Add:
```python
"session_best": loaded.get("session_best", {}),
"fastest_qual_lap_s": loaded.get("fastest_qual_lap_s"),
"stints": {code: loaded["lap_data"][code]["stints"] for code in loaded["lap_data"]},
"pit_stops": {code: loaded["lap_data"][code]["pit_stops"] for code in loaded["lap_data"]},
```

### 0.5 Verification

```bash
python -m src.web.pit_wall_server --year 2026 --round 1 &
sleep 90   # wait for load
curl -s localhost:8000/api/session/summary | jq '.drivers[0]'  # sanity
python -c "import asyncio,websockets,json
async def m():
  async with websockets.connect('ws://localhost:8000/ws/telemetry') as w:
    snap = None
    while True:
      msg = json.loads(await w.recv())
      if msg['type']=='snapshot': snap=msg; break
    print('session_best', snap['session_best'])
    print('stints keys', list(snap['stints'])[:3])
    frame = json.loads(await w.recv())
    s0 = frame['standings'][0]
    print('last_s1_s', s0.get('last_s1_s'), 'pb_lap', s0.get('personal_best_lap_s'), 'in_pit', s0['in_pit'])
asyncio.run(m())"
```

Expect: non-null sector splits for drivers who've completed a lap, `in_pit=True` for drivers on a pit lap, `session_best.s1_s` is a plausible sub-30s float.

---

## Phase 1 — Frontend data layer: expose the new fields

File: [project/src/data.jsx](./src/data.jsx)

### 1.1 Plumb new fields through `computeStandings`

In the `.map` at [data.jsx:145-165](./src/data.jsx#L145-L165), propagate:
```js
lastS1: s.last_s1_s ?? null,
lastS2: s.last_s2_s ?? null,
lastS3: s.last_s3_s ?? null,
pbLap: s.personal_best_lap_s ?? null,
pbS1: s.personal_best_s1_s ?? null,
pbS2: s.personal_best_s2_s ?? null,
pbS3: s.personal_best_s3_s ?? null,
stint: s.stint ?? 1,
```

### 1.2 Snapshot accessor

Add near the bottom of data.jsx:
```js
function getSessionBest() {
  return window.__LIVE_SNAPSHOT?.session_best || {};
}
function getStints(code) {
  return window.__LIVE_SNAPSHOT?.stints?.[code] || [];
}
function getPitStops(code) {
  return window.__LIVE_SNAPSHOT?.pit_stops?.[code] || [];
}
window.APEX.getSessionBest = getSessionBest;
window.APEX.getStints = getStints;
window.APEX.getPitStops = getPitStops;
```

### 1.3 Store the snapshot

File: [project/src/live_state.jsx](./src/live_state.jsx)

In the `snapshot`/`reset` branch, in addition to `setSnap(msg)`, assign `window.__LIVE_SNAPSHOT = msg;` so data.jsx accessors work synchronously for non-React code.

### 1.4 Fix `telemetryFor` bug: synthetic RPM

File: [data.jsx:179](./src/data.jsx#L179)

`rpm` is currently `speed*30+7000`. Leave as derived **but label it**: rename the returned key to `rpm_synthetic` and update any consumer. Alternative if we decide it's fine: keep `rpm` but add `rpm_is_synthetic: true`. Prefer the former — consumers will then consciously choose whether to render.

### 1.5 Fix `telemetryFor` bug: missing ers/fuel

Keep returning `0`, but add `ers_available: false, fuel_available: false`. DriverCard uses these to hide or dim the bars (Phase 2.4 below).

### 1.6 Verification

Open browser, in console: `window.APEX.getSessionBest()` returns an object with `s1_s/s2_s/s3_s/lap_s` numbers after a few laps have elapsed.

---

## Phase 2 — Bug fixes (frontend)

### 2.1 DriverCard hardcoded compound

File: [project/src/Telemetry.jsx](./src/Telemetry.jsx) — `DriverCard`

Currently the TYRE MicroStat reads `COMPOUNDS.M`. Change it to read `code`'s live compound:

```jsx
// at top of DriverCard, resolve the current standings entry:
const live = window.APEX.computeStandings().find(s => s.driver.code === code);
const compoundKey = live?.compound || "M";
const compound = COMPOUNDS[compoundKey];
// then render compound.label and compound.color
// and tyre age from live.tyreAge
```

Propagate `tyreAge` into the MicroStat label (e.g. `MEDIUM · 14L`).

### 2.2 SectorTimes fake sine wave

File: [Telemetry.jsx](./src/Telemetry.jsx) — `SectorTimes` (~line 243)

Replace `Math.sin(lap*2)*...` with real data from standings:

```jsx
const primary = standings.find(s => s.driver.code === pinned);
const secondary = standings.find(s => s.driver.code === secondaryCode);
const best = window.APEX.getSessionBest();
// Render 3 rows × (PRIMARY | SECONDARY | BEST) using live.lastS1/2/3 and best.s1_s/s2_s/s3_s
// When lastS1 == pbS1 → gold; when lastS1 == best.s1_s → purple; else default.
```

If standings arrives before any lap completes, show `--:---` placeholders.

### 2.3 CompareTraces fake data + absolute-positioned channel buttons

File: [Telemetry.jsx](./src/Telemetry.jsx) — `CompareTraces`; [App.jsx:340-357](./src/App.jsx#L340-L357)

**Until real per-lap traces land (Phase-3, outside this plan):**
1. Badge the panel "SIM" in the top-right (small monospaced tag, 9px, matches existing HUD chips) so users know it's fabricated.
2. Move channel buttons from the absolute-positioned overlay in App.jsx into `CompareTraces`'s own header row. Delete the `<div style={{position:"absolute",top:6,left:120...`>` block. Pass `channel` + `setChannel` as props.

**Playhead line:** add a vertical line at `x = t_within_lap * width` over the chart. Even with synthetic data, this ties the chart to playback.

### 2.4 DriverCard ERS/FUEL shown as live when they're zero

File: [Telemetry.jsx](./src/Telemetry.jsx) — `DriverCard`

When `data.ers_available === false`, render the ERS bar dimmed with label "ERS · N/A". Same for fuel. Don't remove the slots; the layout is part of the fixed aesthetic.

### 2.5 Timeline scrub floods `/seek`

File: [project/src/Controls.jsx](./src/Controls.jsx) — `Timeline`

Current: `setT(tVal)` fires on every `onChange`. Fix:
1. Track a local `scrubT` state that updates immediately on drag (for visual feedback).
2. Only call `setT` (which POSTs) on `onMouseUp`/`onTouchEnd`/`onChange` **commit**. Or debounce 120 ms.
3. During active scrub, freeze the timeline's rendered `t` to `scrubT` instead of the server's `t` so the thumb doesn't jitter.

### 2.6 `CameraControls.showProgress` toggle is dead

See Phase 4.3 — we wire it to a new per-driver progress arc.

### 2.7 `Timeline.safetyCarEvents` hardcoded to `[]`

See Phase 3.1 (RC markers).

### 2.8 FlagBadge can't show flag + SC simultaneously

File: [Controls.jsx](./src/Controls.jsx) — `TopBar`/`FlagBadge`

Allow a secondary chip next to the primary flag. When `flagState === "yellow"` AND `safetyCar === true`, render the YELLOW badge plus a small "SC" sub-chip (same dimensions as a HUD tag). Data is already wired in App.jsx.

### 2.9 `lastLap < bestLap + 0.2` doesn't distinguish PB vs session best

File: [project/src/Leaderboard.jsx](./src/Leaderboard.jsx)

Currently `bestLapCode` is the one driver with the fastest overall lap (rendered purple). Extend:
- **Purple (`#C15AFF`)**: overall session fastest (`bestLapCode`).
- **Green (`#1EFF6A`)**: this driver's own personal-best lap this session (`live.lastLap === live.pbLap`).
- **Yellow (`#FFD93A`)**: within 0.2s of PB (existing behavior).
- Else default.

Use live `pbLap` from Phase 1.1.

### 2.10 Verification

Open `/app/Pit%20Wall.html`, run a race for 5 laps:
- DriverCard TYRE shows real compound (e.g. `SOFT · 7L`), not always MEDIUM.
- Sector times show realistic values (20–40s), no perfect sine pattern.
- Scrubbing the timeline doesn't spam network tab; one request on release.
- Under yellow+SC, both badges show.
- PB laps glow green in leaderboard; absolute fastest glows purple on one row only.

---

## Phase 3 — Tier 1 features

### 3.1 RC-event markers on scrub bar + click-to-seek

File: [Controls.jsx](./src/Controls.jsx) — `Timeline`; [App.jsx:383-389](./src/App.jsx#L383-L389)

1. In App.jsx, derive event markers from `rc`:
   ```js
   const tMax = snapshot?.event?.total_laps ? (maxFrameIdx) : maxFrameIdx; // frames
   const rcMarkers = (rc || []).map(m => {
     const cat = (m.category||"").toUpperCase();
     const flag = (m.flag||"").toUpperCase();
     let kind = "info";
     if (cat.includes("SAFETY") || flag.includes("SC")) kind = "sc";
     else if (cat.includes("FLAG") || flag.includes("YELLOW") || flag.includes("RED")) kind = "flag";
     else if (cat.includes("DRS")) kind = "drs";
     // rc m.time is seconds since session start; timeline is 0..1 over frames.
     // Approximate: t_frac = m.time / (maxFrameIdx * (1/FPS))  — FPS=25, so /maxFrameIdx*25
     const tFrac = Math.min(1, Math.max(0, (m.time * 25) / Math.max(maxFrameIdx,1)));
     return { t: tFrac, kind, label: m.message, time: m.time };
   });
   ```
   Pass `rcMarkers` to `Timeline` (replace `safetyCarEvents={[]}`).

2. In Timeline, render each marker as a 2px-wide tick above the scrub bar at `left = t*100%`. Colors: `flag=#FFD93A`, `sc=#FFB800`, `drs=#00D9FF`, `info=rgba(180,180,200,0.4)`. On hover show the label in a tooltip. On click call `setT(marker.t)`.

3. Debounce-safe with 2.5's scrubbing fix.

### 3.2 Hover car tooltip on IsoTrack

File: [IsoTrack.jsx](./src/IsoTrack.jsx)

Currently `hover` state exists but only drives opacity halo. Add a tooltip:

1. When `hover` is set, locate the standings row: `const h = standings.find(s => s.driver.code === hover)`.
2. Render a foreignObject (or an absolute-positioned `<div>` anchored at the car's `p.x + OX, p.y + OY`) containing:
   ```
   P{pos}  {CODE}  {driver.name short}
   GAP  +{gap}s
   INT  +{interval}s
   TYRE {compound} · {tyreAge}L
   LAST {lastLap fmt}
   ```
   Style inline with the HUD's existing conventions (rgba(11,11,17,0.9) bg, accent border). Keep to ~180×90 px.
3. Position the tooltip offset away from the track edge using the same perpendicular normal we compute for sector ticks, so it doesn't cover neighbors.

### 3.3 Weather strip + flag banner wiring

The data is already wired through to `TopBar` — confirm on read. If TopBar already renders weather/flag, no change beyond 2.8. If not, add a compact 3-stat weather chip (AIR / TRACK / HUM) inside TopBar — data pulled from `App.jsx`'s `weather` object. `rainfall` (Phase 0 extension) adds a small raindrop icon when `> 0`.

### 3.4 Verification

- Timeline shows colored ticks during SC and yellow-flag periods; clicking a tick seeks.
- Hovering a car shows the mini card; card tracks the car as it moves.
- Weather values change across the race; rain icon appears during wet sessions (verify on a known wet race, e.g. 2021 Spa).

---

## Phase 4 — Tier 2 features

### 4.1 Pit-window indicator

File: [Leaderboard.jsx](./src/Leaderboard.jsx); optional helper in [data.jsx](./src/data.jsx).

1. Add a helper `window.APEX.pitWindow(standings, code)` that returns `"undercut" | "overcut" | "window" | null`:
   - For driver at `pos`, find the driver at `pos-1` (ahead).
   - If `live.tyreAge >= THRESHOLD_FOR_COMPOUND[compound]` (e.g. S=15, M=22, H=30) → driver is "in window".
   - If `interval < 22s` (roughly a pit-stop delta for most tracks — read from `snapshot?.event` when we have a real pit-loss value, else constant) AND ahead's tyreAge is lower than threshold → `"undercut"` (we threaten to box first).
   - If ahead is already past threshold and we haven't reached it → `"overcut"`.
   - Else null.
2. In the leaderboard row, render a tiny glyph in an unused corner of the TYRE pip: a small wedge icon, color-coded (`undercut=#FF1E00, overcut=#00D9FF, window=#FFD93A`). Hover tooltip explains.

Use real pit-loss if available (from snapshot if we add it later); for now a per-track constant in data.jsx (`PIT_LOSS_S = 22`) is acceptable.

### 4.2 Gap-to-leader sparkline per row

Files: [live_state.jsx](./src/live_state.jsx), [Leaderboard.jsx](./src/Leaderboard.jsx).

1. In `LiveProvider`, maintain a ring buffer keyed by driver code:
   ```js
   const gapHistoryRef = React.useRef({}); // {code: Float32Array length 120}
   const gapCursorRef = React.useRef(0);
   ```
   On each `frame` message, for each standings row push `gap_s` into the ring (overwriting oldest). Expose `gapHistoryRef.current` via context.

2. In Leaderboard, add a narrow column (40px) rendering a 120-sample SVG polyline per row. Y is gap relative to that row's min/max over the window; X is linear. Color the line with the team color at 70% opacity. Zero allocations per frame: reuse the same Float32Array.

3. Sparkline height must fit inside existing row height — no grid changes. Place it between TYRE and LAST columns (or wherever a column can absorb 40px without reflow — confirm by reading Leaderboard's column definitions before coding).

### 4.3 On-track DRS-active chevron

File: [IsoTrack.jsx](./src/IsoTrack.jsx).

1. A driver is "DRS-active" when: `live.inDRS === true` AND their `trackIdx` is inside any `DRS_ZONES` range AND the car ahead (by position, not track distance) has `interval < 1.0s`.
2. Replace the current static "DRS" rect badge with a directional chevron (▶) painted in `#FF1E00`, pointing along the local track tangent (compute from `CIRCUIT[idx+1] - CIRCUIT[idx]`, same math as sector ticks). Position: 8S ahead of the car, not overlapping the code label.
3. Keep the small "DRS" rect for the non-active case (driver is in a DRS zone but > 1s behind) — render in dim grey. This distinguishes "available" from "firing".

### 4.4 Sector-dominance tri-bar on Leaderboard LAST column

File: [Leaderboard.jsx](./src/Leaderboard.jsx).

Replace the single green/purple `LAST` lap cell with a three-segment mini-bar (S1|S2|S3). Each segment:
- Purple `#C15AFF` if `live.lastSN === sessionBest.sN_s`
- Green `#1EFF6A` if `live.lastSN === live.pbSN`
- Neutral (existing color) otherwise
Below the bar, show the total lap time as today. Width matches current LAST column; don't change grid columns.

If `lastSN` is null (no completed lap), render dashes.

### 4.5 Wire dead `showProgress` toggle — per-driver progress arc

File: [IsoTrack.jsx](./src/IsoTrack.jsx), [App.jsx:78](./src/App.jsx#L78) (`showProgress` already passed through).

When `showProgress` is on, render a thin arc behind each car representing lap fraction (0→1 around a small circle at the car's position). Stroke in team color, 1px, r=12S, `stroke-dasharray` set to `fraction*circumference`. This recovers the toggle and adds real information density without styling changes.

### 4.6 Verification

- Drivers due to pit show undercut/overcut/window glyphs consistent with tyre age.
- Sparklines track gap changes over ~2 minutes of playback; leader row is flat.
- DRS chevrons fire only on cars within 1s in a DRS zone; availability state differs visually.
- Leaderboard LAST shows tri-color segments; purple appears only for session-best sectors.
- Toggling `B` (showProgress hotkey) shows/hides progress arcs.

---

## Phase 5 — On-track driver visibility overhaul

Current car glyph: `<circle r=9>` with position number inside and an absolute-positioned code label. Problems: cars overlap in battles collapsing to one pip; labels collide; color-on-color unreadable for white/gold teams; no velocity indication.

### 5.1 Battle-spread (tangential jitter for near-overlap)

File: [IsoTrack.jsx](./src/IsoTrack.jsx) — in the `standings.map` rendering.

Before rendering, group cars by `trackIdx` bucket (bucket size = 6 indices). Within each bucket of size > 1, offset each car perpendicular to the tangent by `(rank - (n-1)/2) * 14 * S`. This preserves on-track position while spreading the pips visually. Use the perpendicular `(nx, ny)` already computed for sector ticks.

### 5.2 Larger, higher-contrast car glyph

- Bump `r` from 9 to 11.
- Outer ring: 1.5px stroke in `#0B0B11`, inner 0.5px stroke in `rgba(255,255,255,0.25)` — gives a pickable silhouette on dark and light team colors alike.
- Position number: keep 9px, bold. **Fix contrast:** pick text color by luminance of team color, not hardcoded exceptions. Compute `Y = 0.2126*R + 0.7152*G + 0.0722*B`; if `Y > 140` use `#0B0B11` else `#FFFFFF`. Delete the current hardcoded `#FFFFFF/#FFD700/#FF8A1E` check.

### 5.3 Dynamic label placement (away from track center)

Currently labels are hardcoded at `translate(14, 4)`. Replace with perpendicular offset based on local tangent:
- Compute `(nx, ny)` for the car's `trackIdx`.
- Choose the side pointing **away** from the circuit centroid (precompute once: `const CENTROID = {x: mean(CIRCUIT.x), y: mean(CIRCUIT.y)}`). The outward perpendicular is whichever of `+n` or `-n` has larger distance from centroid.
- Offset the label group by `outward * 18 * S`.

This keeps labels from colliding on inside-of-turn cars and stops DRS badges from covering neighbors.

### 5.4 Velocity hue (subtle)

Add a 1px radial halo (r=15, no fill, stroke team color, opacity `0.2 + 0.5*(speed_kph/350)`) behind each car. Fast cars visibly glow; slow/pitting cars are flat. Zero layout change.

### 5.5 Pit-status rendering

When `status === "PIT"`, render the car at 50% opacity, add a "P" glyph overlay above the number, and skip the velocity halo. When `status === "OUT"` (now emitted per Phase 0.3), render as a hollow circle in grey at the driver's last known position — or hide entirely, toggleable via a new "show retired" control (defer unless cheap).

### 5.6 Hover & pin state refinements

- Hover halo radius from 18 to 22.
- Pinned: add a second outer ring at r=16 in `#FF1E00` stroke (dashed, 2px).
- Secondary: same but `#00D9FF`.
- Ensure hover+pin layers stack correctly (draw pin ring first, then hover halo, then glyph).

### 5.7 Verification

- Load a 2024 race with heavy mid-pack battles; pick a frame where two cars are within 0.3s. Confirm both pips visible and non-overlapping.
- Cars with white/yellow team colors (Haas, last-era McLaren papaya) show readable position numbers.
- Labels never sit on the track surface — always on the outside of the turn.
- Fast cars glow; pitting cars are dim with a P overlay.

---

## Phase 6 — Documentation + acceptance

### 6.1 Update README_WEB.md

Add a "What's rendered where" section enumerating: weather (TopBar), flag+SC (TopBar), RC markers (Timeline), hover tooltip (IsoTrack), pit window (Leaderboard), sparkline (Leaderboard), DRS chevron (IsoTrack), sector tri-bar (Leaderboard), progress arc (IsoTrack, toggle `B`).

### 6.2 Acceptance checklist

- [ ] No `Math.sin`/`Math.cos` in any component file except IsoTrack geometry math.
- [ ] `in_pit=true` observed at least once during a race (verify with `jq '.standings[] | select(.in_pit==true)'` on a WS frame).
- [ ] Sector times in UI match `curl /api/session/summary` within ±0.01s (after we expose them via REST, optional).
- [ ] Timeline POSTs exactly one `/seek` per drag gesture.
- [ ] RC ticks present for every SC and yellow period.
- [ ] IsoTrack shows no more than one car at any single pixel position during a 3-way battle.
- [ ] Position numbers legible on every team color.
- [ ] Desktop Qt path (`python main.py`) still works unchanged.

### 6.3 Risks

| Risk | Mitigation |
|---|---|
| `session.laps` lacks sector splits for some drivers (crashed lap 1). | Null-guard everywhere; render `--:---`. |
| RC `m.time` is not always seconds-since-session-start. | Validate by printing first 3 `rc` entries on load; if wrong, convert via `(m.time - session_start_s)`. |
| Sparkline ring buffer causes GC churn. | Use pre-allocated `Float32Array` per code; never realloc. |
| Battle-spread perpendicular offset puts cars on wrong side of track. | Clamp to outward normal (same centroid trick as 5.3). |
| Large DRIVERS count (>22, historical entries lists) blows up grouping. | Only iterate over active codes from current frame's standings. |

---

## Execution order (one more time, short form)

1. Phase 0 (backend) → verify WS payload carries sectors + real `in_pit` + session_best.
2. Phase 1 (data.jsx plumbing) → verify console accessors.
3. Phase 2 (bug fixes) — do 2.1–2.9 in any order, verify each.
4. Phase 3.1 (RC ticks), 3.2 (hover tooltip), 3.3 (weather icon if not already).
5. Phase 4 (Tier 2) — 4.1, 4.4 first (high value), then 4.2, 4.3, 4.5.
6. Phase 5 (on-track visibility) — 5.1, 5.2, 5.3 first, then 5.4–5.6.
7. Phase 6 — docs + acceptance.

Estimated effort: **3–5 days** for a single engineer, backend-light. Phase 0 is the largest single chunk (~4h); most frontend items are 30–90 min each.
