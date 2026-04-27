from pathlib import Path
import os
import time
import numpy as np
from scipy.spatial import cKDTree

import fastf1
from src.f1_data import load_session, get_race_telemetry, get_circuit_rotation
from src.data import perf_metrics
from src.data.race_store import (
    RaceHandle,
    migrate_pickle_file_to_arrow,
)

try:
    import psutil
except Exception:  # pragma: no cover - optional at import time
    psutil = None

_LOAD_STATE = {"status": "idle", "progress": 0, "message": "", "year": None, "round": None}


def loading_state() -> dict:
    return dict(_LOAD_STATE)


class SessionManager:
    def __init__(self, cache_dir: Path):
        self._loaded: dict | None = None
        cache_dir.mkdir(parents=True, exist_ok=True)
        fastf1.Cache.enable_cache(str(cache_dir))

    def load(self, year: int, round_number: int, session_type: str = "R") -> dict:
        load_started = time.perf_counter()
        _LOAD_STATE.update(
            status="loading", progress=5,
            message=f"Loading {year} R{round_number} {session_type}",
            year=year, round=round_number,
        )
        try:
            session_started = time.perf_counter()
            session = load_session(year, round_number, session_type)
            perf_metrics.log(f"session_load_s={time.perf_counter() - session_started:.4f}")
            _LOAD_STATE.update(progress=30, message="Computing telemetry")
            telemetry_started = time.perf_counter()
            race, handle = _load_race_payload(session, session_type)
            perf_metrics.log(f"race_cache_load_s={time.perf_counter() - telemetry_started:.4f}")
            if psutil is not None:
                rss_bytes = int(psutil.Process().memory_info().rss)
                perf_metrics.log(f"rss_after_get_race_telemetry_mb={rss_bytes / (1024 * 1024):.2f}")
            _LOAD_STATE.update(progress=70, message="Building geometry")

            geometry = _extract_geometry(race, session)
            driver_meta = _extract_driver_meta(session)
            driver_results = _extract_driver_results(session)
            rotation = get_circuit_rotation(session)
            lap_data = _precompute_lap_data(session)
            lap_aggregates = _compute_lap_aggregates(lap_data)
            frames = race.get("frames")
            track_statuses = race["track_statuses"]
            if frames:
                total_duration_s = float(frames[-1]["t"])
            elif handle is not None and handle.frame_count > 0:
                total_duration_s = float((handle.frame_count - 1) / max(handle.fps, 1))
            else:
                total_duration_s = 0.0
            total_laps = int(race["total_laps"])

            self._loaded = {
                "year": year,
                "round": round_number,
                "session_type": session_type,
                "session": session,
                "frames": frames,
                "handle": handle,
                "driver_colors_hex": {
                    k: "#{:02X}{:02X}{:02X}".format(*v)
                    for k, v in race["driver_colors"].items()
                },
                "track_statuses": track_statuses,
                "track_status_start_times": [float(e["start_time"]) for e in track_statuses],
                "race_control_messages": race["race_control_messages"],
                "total_laps": total_laps,
                "total_duration_s": total_duration_s,
                "max_tyre_life": race["max_tyre_life"],
                "telemetry_ranges": race.get("telemetry_ranges", {}),
                "circuit_rotation": rotation,
                "geometry": geometry,
                "driver_meta": driver_meta,
                "driver_results": driver_results,
                "driver_stop_windows": _compute_driver_stop_windows(
                    frames if frames is not None else handle, driver_results
                ),
                "event": _event_info(session, year, round_number, {"total_laps": total_laps}),
                "lap_data": lap_data,
                "lap_aggregates": lap_aggregates,
                "session_best": _compute_session_best(session),
                "fastest_qual_lap_s": _fastest_qual_lap_s(session),
            }
            perf_metrics.log(f"session_manager_load_total_s={time.perf_counter() - load_started:.4f}")
            _LOAD_STATE.update(status="ready", progress=100, message="Ready")
            return self._loaded
        except Exception as e:
            _LOAD_STATE.update(status="error", message=str(e))
            raise

    def current(self) -> dict | None:
        return self._loaded


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

def _cache_paths(session, session_type: str) -> tuple[Path, Path]:
    event_name = str(session).replace(" ", "_")
    suffix = "sprint" if session_type == "S" else "race"
    session_tag = "S" if session_type == "S" else "R"
    pickle_path = Path("computed_data") / f"{event_name}_{suffix}_telemetry.pkl"
    arrow_path = Path("computed_data") / f"{event_name}_{session_tag}.arrow"
    return pickle_path, arrow_path


def _rgb_triplet(value) -> tuple[int, int, int]:
    if isinstance(value, str) and value.startswith("#") and len(value) >= 7:
        return (int(value[1:3], 16), int(value[3:5], 16), int(value[5:7], 16))
    if isinstance(value, (list, tuple)) and len(value) >= 3:
        return (int(value[0]), int(value[1]), int(value[2]))
    return (128, 128, 128)


def _load_race_payload(session, session_type: str) -> tuple[dict, RaceHandle | None]:
    use_legacy = os.getenv("APEX_USE_LEGACY_CACHE", "0") == "1"
    if use_legacy:
        return get_race_telemetry(session, session_type=session_type), None

    pickle_path, arrow_path = _cache_paths(session, session_type)
    if not arrow_path.exists():
        if pickle_path.exists():
            migrate_pickle_file_to_arrow(pickle_path, arrow_path)
        else:
            # Build Arrow cache directly without materializing dense legacy frames.
            get_race_telemetry(session, session_type=session_type, include_frames=False)
            if not arrow_path.exists():
                raise FileNotFoundError(f"Arrow cache was not created at {arrow_path}")

    handle = RaceHandle(arrow_path)
    meta = handle.meta
    driver_colors = {
        code: _rgb_triplet(color)
        for code, color in (meta.get("driver_colors") or {}).items()
    }
    payload = {
        "frames": None,
        "driver_colors": driver_colors,
        "track_statuses": meta.get("track_statuses", []),
        "race_control_messages": meta.get("race_control_messages", []),
        "total_laps": int(meta.get("total_laps", 0)),
        "max_tyre_life": meta.get("max_tyre_life", {}),
        "telemetry_ranges": meta.get("telemetry_ranges", {}),
    }
    return payload, handle

def _pick_example_lap(session):
    """Same chain as main.py:50-67 — prefer quali lap for DRS zones."""
    example_lap = None
    try:
        quali_session = load_session(
            session.event.year, session.event.round_number, "Q"
        )
        if quali_session is not None and len(quali_session.laps) > 0:
            fastest_quali = quali_session.laps.pick_fastest()
            if fastest_quali is not None:
                quali_telemetry = fastest_quali.get_telemetry()
                if "DRS" in quali_telemetry.columns:
                    example_lap = quali_telemetry
    except Exception:
        pass

    if example_lap is None:
        fastest_lap = session.laps.pick_fastest()
        if fastest_lap is not None:
            example_lap = fastest_lap.get_telemetry()

    return example_lap


def _extract_geometry(race, session):
    """Try Arcade-based builder; fall back to pure-numpy."""
    example_lap = _pick_example_lap(session)

    try:
        from src.ui_components import build_track_from_example_lap
        raw = build_track_from_example_lap(example_lap)
    except ImportError:
        from src.lib.track_geometry import build_track_pure
        raw = build_track_pure(example_lap)

    return _shape_geometry_payload(raw, session, race)


def _shape_geometry_payload(raw, session, race):
    (plot_x_ref, plot_y_ref,
     x_inner, y_inner,
     x_outer, y_outer,
     x_min, x_max,
     y_min, y_max, drs_zones, plot_z_ref) = raw

    # Build dense reference polyline + cumulative distances
    ref_xs, ref_ys, ref_cumdist, ref_total_length = _build_reference(
        plot_x_ref, plot_y_ref
    )

    # Sector boundaries (from session if available)
    sector_boundaries_m = []
    try:
        circuit_info = session.get_circuit_info()
        if hasattr(circuit_info, "sector_start_distances"):
            sector_boundaries_m = list(
                float(x) for x in circuit_info.sector_start_distances
            )
    except Exception:
        pass

    # DRS zones in index + metre form
    drs_payload = []
    for z in drs_zones:
        si = z["start"]["index"]
        ei = z["end"]["index"]
        drs_payload.append({
            "start_idx": si,
            "end_idx": ei,
            "start_m": float(ref_cumdist[min(si, len(ref_cumdist) - 1)]),
            "end_m": float(ref_cumdist[min(ei, len(ref_cumdist) - 1)]),
        })

    return {
        "centerline": {
            "x": _tolist(plot_x_ref),
            "y": _tolist(plot_y_ref),
            "z": _tolist(plot_z_ref) if plot_z_ref is not None else None,
        },
        "inner": {"x": _tolist(x_inner), "y": _tolist(y_inner)},
        "outer": {"x": _tolist(x_outer), "y": _tolist(y_outer)},
        "drs_zones": drs_payload,
        "sector_boundaries_m": sector_boundaries_m,
        "rotation_deg": float(get_circuit_rotation(session)),
        "total_length_m": float(ref_total_length),
        "bbox": {
            "x_min": float(x_min),
            "x_max": float(x_max),
            "y_min": float(y_min),
            "y_max": float(y_max),
        },
        # Internal fields used by Playback for projection (not sent to client)
        "_ref_xs": ref_xs,
        "_ref_ys": ref_ys,
        "_ref_cumdist": ref_cumdist,
        "_ref_total_length": ref_total_length,
        "_track_tree": cKDTree(np.column_stack((ref_xs, ref_ys))),
    }


def _build_reference(plot_x_ref, plot_y_ref, interp_points=4000):
    """Interpolate a dense reference polyline and compute cumulative distances."""
    t_old = np.linspace(0, 1, len(plot_x_ref))
    t_new = np.linspace(0, 1, interp_points)
    ref_xs = np.interp(t_new, t_old, plot_x_ref)
    ref_ys = np.interp(t_new, t_old, plot_y_ref)

    diffs = np.sqrt(np.diff(ref_xs) ** 2 + np.diff(ref_ys) ** 2)
    cumdist = np.concatenate(([0.0], np.cumsum(diffs)))
    total_length = float(cumdist[-1]) if len(cumdist) > 0 else 0.0
    return ref_xs, ref_ys, cumdist, total_length


def _tolist(arr):
    """Convert pandas/numpy array to plain Python list."""
    if hasattr(arr, "tolist"):
        return arr.tolist()
    return list(arr)


def _extract_driver_meta(session):
    out = {}
    for num in session.drivers:
        d = session.get_driver(num)
        out[d["Abbreviation"]] = {
            "code": d["Abbreviation"],
            "number": int(d.get("DriverNumber", 0) or 0),
            "full_name": d.get("FullName", ""),
            "team": d.get("TeamName", ""),
            "team_color": "#" + d["TeamColor"] if d.get("TeamColor") else "",
            "country": d.get("CountryCode", ""),
        }
    return out


def _extract_driver_results(session):
    out = {}
    results = getattr(session, "results", None)
    if results is None:
        return out

    def _clean_str(value):
        try:
            if value is None or np.isnan(value):
                return ""
        except TypeError:
            pass
        return str(value or "").strip()

    for _, row in results.iterrows():
        code = row.get("Abbreviation")
        if not code:
            continue
        pos_raw = row.get("Position")
        try:
            position = int(pos_raw) if pos_raw is not None and not np.isnan(pos_raw) else None
        except TypeError:
            position = None
        out[code] = {
            "status": _clean_str(row.get("Status", "")),
            "classified_position": _clean_str(row.get("ClassifiedPosition", "")),
            "position": position,
        }
    return out


def _normalise_result_status(status: str | None) -> str:
    return " ".join(str(status or "").strip().lower().split())


def _is_dns_status(status: str | None) -> bool:
    norm = _normalise_result_status(status)
    return "did not start" in norm or norm == "dns"


def _is_finished_status(status: str | None) -> bool:
    norm = _normalise_result_status(status)
    if not norm:
        return False
    if norm == "finished":
        return True
    if norm.startswith("+") and "lap" in norm:
        return True
    if "classified" in norm and "not classified" not in norm:
        return True
    return False


def _compute_driver_stop_windows_columnar(frame_source, driver_results: dict[str, dict]) -> dict[str, dict]:
    out = {}
    frame_count = int(getattr(frame_source, "frame_count", 0))
    if frame_count <= 0:
        return out

    fps = float(getattr(frame_source, "fps", 60) or 60)
    if fps <= 0:
        fps = 60.0

    min_stop_duration_s = 3.0
    move_threshold_m = 3.0
    rel_dist_threshold = 0.002
    speed_threshold_kph = 8.0
    trailing_end_idx = frame_count - 1

    for code, result in driver_results.items():
        status = result.get("status", "")
        if _is_dns_status(status) or _is_finished_status(status):
            continue

        try:
            xs = np.asarray(frame_source.column(code, "x"), dtype=np.float64)
            ys = np.asarray(frame_source.column(code, "y"), dtype=np.float64)
            rel = np.asarray(frame_source.column(code, "rel_dist"), dtype=np.float64)
            laps = np.asarray(frame_source.column(code, "lap"), dtype=np.int16)
            speeds = np.asarray(frame_source.column(code, "speed"), dtype=np.float64)
        except Exception:
            continue

        if (
            xs.shape[0] != frame_count
            or ys.shape[0] != frame_count
            or rel.shape[0] != frame_count
            or laps.shape[0] != frame_count
            or speeds.shape[0] != frame_count
        ):
            continue

        trailing_start_idx = trailing_end_idx
        newer_idx = trailing_end_idx
        for idx in range(trailing_end_idx - 1, -1, -1):
            moved_xy = np.hypot(xs[newer_idx] - xs[idx], ys[newer_idx] - ys[idx]) > move_threshold_m
            moved_progress = abs(rel[newer_idx] - rel[idx]) > rel_dist_threshold
            lap_changed = int(laps[newer_idx]) != int(laps[idx])
            moving_fast = max(float(speeds[newer_idx]), float(speeds[idx])) > speed_threshold_kph
            if moved_xy or moved_progress or lap_changed or moving_fast:
                break
            trailing_start_idx = idx
            newer_idx = idx

        duration_s = (trailing_end_idx - trailing_start_idx) / fps
        if duration_s < min_stop_duration_s:
            continue

        start_t = trailing_start_idx / fps
        end_t = trailing_end_idx / fps
        out[code] = {
            "start_time": start_t,
            "end_time": end_t,
            "duration_s": duration_s,
        }

    return out


def _compute_driver_stop_windows(frame_source, driver_results: dict[str, dict]) -> dict[str, dict]:
    out = {}
    if frame_source is None:
        return out

    if isinstance(frame_source, list):
        if not frame_source:
            return out
        frame_count = len(frame_source)
        frame_at = frame_source.__getitem__
    else:
        frame_count = int(getattr(frame_source, "frame_count", 0))
        if frame_count <= 0:
            return out
        if hasattr(frame_source, "column"):
            return _compute_driver_stop_windows_columnar(frame_source, driver_results)
        frame_at = frame_source.frame_at

    min_stop_duration_s = 3.0
    move_threshold_m = 3.0
    rel_dist_threshold = 0.002
    speed_threshold_kph = 8.0

    for code, result in driver_results.items():
        status = result.get("status", "")
        if _is_dns_status(status) or _is_finished_status(status):
            continue

        trailing_end_t = None
        trailing_start_t = None
        newer_driver = None

        for frame_idx in range(frame_count - 1, -1, -1):
            frame = frame_at(frame_idx)
            driver = frame.get("drivers", {}).get(code)
            if driver is None:
                continue

            t = float(frame.get("t", 0.0))
            if trailing_end_t is None:
                trailing_end_t = t
                trailing_start_t = t
                newer_driver = driver
                continue

            dx = float(newer_driver.get("x", 0.0)) - float(driver.get("x", 0.0))
            dy = float(newer_driver.get("y", 0.0)) - float(driver.get("y", 0.0))
            moved_xy = np.hypot(dx, dy) > move_threshold_m
            moved_progress = abs(float(newer_driver.get("rel_dist", 0.0)) - float(driver.get("rel_dist", 0.0))) > rel_dist_threshold
            lap_changed = int(round(newer_driver.get("lap", 1))) != int(round(driver.get("lap", 1)))
            moving_fast = max(float(newer_driver.get("speed", 0.0)), float(driver.get("speed", 0.0))) > speed_threshold_kph

            if moved_xy or moved_progress or lap_changed or moving_fast:
                break

            trailing_start_t = t
            newer_driver = driver

        if trailing_start_t is None or trailing_end_t is None:
            continue
        if trailing_end_t - trailing_start_t < min_stop_duration_s:
            continue

        out[code] = {
            "start_time": trailing_start_t,
            "end_time": trailing_end_t,
            "duration_s": trailing_end_t - trailing_start_t,
        }

    return out


def _event_info(session, year, round_number, race):
    return {
        "event_name": session.event.get("EventName", ""),
        "circuit_name": session.event.get("Location", ""),
        "country": session.event.get("Country", ""),
        "year": year,
        "round": round_number,
        "date": str(session.event.get("EventDate", "")),
        "total_laps": race["total_laps"],
    }


def _precompute_lap_data(session):
    """Return enriched per-driver lap data: laps dict, stints list, pit_stops list."""
    import pandas as pd

    out = {}
    laps = session.laps
    for _, row in laps.iterrows():
        code = row["Driver"]
        lap_no = int(row["LapNumber"])

        def _to_s(val):
            if val is None or pd.isna(val):
                return None
            if hasattr(val, "total_seconds"):
                return val.total_seconds()
            return None

        def _to_bool(val):
            if val is None or pd.isna(val):
                return False
            return bool(val)

        lap_entry = {
            "lap_time_s": _to_s(row.get("LapTime")),
            "s1_s": _to_s(row.get("Sector1Time")),
            "s2_s": _to_s(row.get("Sector2Time")),
            "s3_s": _to_s(row.get("Sector3Time")),
            "is_personal_best": _to_bool(row.get("IsPersonalBest")),
            "compound": str(row.get("Compound")) if pd.notna(row.get("Compound")) else None,
            "tyre_life": int(row["TyreLife"]) if pd.notna(row.get("TyreLife")) else 0,
            "stint": int(row["Stint"]) if pd.notna(row.get("Stint")) else 1,
            "pit_in": pd.notna(row.get("PitInTime")),
            "pit_out": pd.notna(row.get("PitOutTime")),
            "fresh_tyre": _to_bool(row.get("FreshTyre")),
            "track_status": str(row.get("TrackStatus")) if pd.notna(row.get("TrackStatus")) else "1",
            "deleted": _to_bool(row.get("Deleted")),
        }
        out.setdefault(code, {}).setdefault("laps", {})[lap_no] = lap_entry

    # Build stints and pit_stops per driver
    for code, driver_data in out.items():
        driver_laps = driver_data["laps"]
        stints = []
        pit_stops = []

        sorted_laps = sorted(driver_laps.items(), key=lambda x: x[0])
        current_stint = None
        stint_start = None
        for lap_no, lap in sorted_laps:
            if lap["pit_in"]:
                pit_stops.append({"lap": lap_no, "duration_s": None})
            if current_stint is None or lap.get("pit_out"):
                if current_stint is not None:
                    # close previous
                    stints[-1]["end_lap"] = lap_no - 1
                    stints[-1]["laps"] = stints[-1]["end_lap"] - stints[-1]["start_lap"] + 1
                current_stint = lap["stint"]
                compound = lap.get("compound") or "UNKNOWN"
                stint_start = lap_no
                stints.append({"stint": current_stint, "compound": compound, "start_lap": stint_start, "end_lap": stint_start, "laps": 1})
            else:
                if stints:
                    stints[-1]["end_lap"] = lap_no
                    stints[-1]["laps"] = lap_no - stints[-1]["start_lap"] + 1
        driver_data["stints"] = stints
        driver_data["pit_stops"] = pit_stops

    return out


def _compute_lap_aggregates(lap_data: dict) -> dict:
    out = {}

    for code, driver_data in lap_data.items():
        laps = driver_data.get("laps", {})
        lap_times = [lap["lap_time_s"] for lap in laps.values() if lap.get("lap_time_s") is not None]
        s1_vals = [lap["s1_s"] for lap in laps.values() if lap.get("s1_s") is not None]
        s2_vals = [lap["s2_s"] for lap in laps.values() if lap.get("s2_s") is not None]
        s3_vals = [lap["s3_s"] for lap in laps.values() if lap.get("s3_s") is not None]

        best_lap_s = round(min(lap_times), 3) if lap_times else None
        out[code] = {
            "best_lap_s": best_lap_s,
            "personal_best_lap_s": best_lap_s,
            "personal_best_s1_s": round(min(s1_vals), 3) if s1_vals else None,
            "personal_best_s2_s": round(min(s2_vals), 3) if s2_vals else None,
            "personal_best_s3_s": round(min(s3_vals), 3) if s3_vals else None,
        }

    return out


def _compute_session_best(session):
    """Return session-wide best sector and lap times in seconds."""
    import pandas as pd
    best = {"s1_s": None, "s2_s": None, "s3_s": None, "lap_s": None}
    laps = session.laps
    for col, key in [("Sector1Time", "s1_s"), ("Sector2Time", "s2_s"), ("Sector3Time", "s3_s"), ("LapTime", "lap_s")]:
        series = laps[col] if col in laps.columns else None
        if series is not None:
            valid = series.dropna()
            if not valid.empty and hasattr(valid.iloc[0], "total_seconds"):
                ts = valid.apply(lambda x: x.total_seconds() if pd.notna(x) else None).dropna()
                if not ts.empty:
                    best[key] = float(ts.min())
    return best


def _fastest_qual_lap_s(session):
    """Return fastest qualifying lap in seconds, or None."""
    try:
        quali = load_session(
            session.event.year, session.event.round_number, "Q"
        )
        fl = quali.laps.pick_fastest()
        if fl is not None and fl.LapTime is not None:
            return fl.LapTime.total_seconds()
    except Exception:
        pass
    return None
