from __future__ import annotations

import json
import math
from bisect import bisect_right
from pathlib import Path
from typing import Iterable

import numpy as np
import pyarrow as pa

FPS_DEFAULT = 60

DRIVER_COLUMNS = {
    "t_idx": pa.uint32(),
    "x": pa.float32(),
    "y": pa.float32(),
    "dist": pa.float32(),
    "rel_dist": pa.float32(),
    "lap": pa.int16(),
    "speed": pa.float32(),
    "gear": pa.int8(),
    "drs": pa.int8(),
    "throttle": pa.float32(),
    "brake": pa.int8(),
    "rpm": pa.float32(),
    "tyre": pa.int8(),
    "tyre_life": pa.float32(),
}

_WEATHER_KEYS = ("track_temp", "air_temp", "humidity", "wind_speed", "wind_direction")


def _tmp_path(path: Path) -> Path:
    return path.with_name(f"{path.name}.tmp")


def _meta_path_for_arrow(arrow_path: Path) -> Path:
    if arrow_path.suffix == ".arrow":
        return arrow_path.with_suffix(".meta.json")
    return arrow_path.parent / f"{arrow_path.name}.meta.json"


def _as_dtype(arr: np.ndarray, dtype) -> np.ndarray:
    return np.asarray(arr).astype(dtype, copy=False)


def write_race(path: Path, driver_arrays: dict, meta: dict) -> None:
    """Write Arrow + sidecar metadata atomically."""
    path = Path(path)
    if path.suffix != ".arrow":
        path = path.with_suffix(".arrow")
    meta_path = _meta_path_for_arrow(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.parent.mkdir(parents=True, exist_ok=True)

    schema = pa.schema([pa.field(name, dtype) for name, dtype in DRIVER_COLUMNS.items()])
    ordered_codes = sorted(driver_arrays.keys())
    batch_metadata = {}

    tmp_arrow = _tmp_path(path)
    tmp_meta = _tmp_path(meta_path)

    with pa.OSFile(str(tmp_arrow), "wb") as sink:
        with pa.ipc.new_file(sink, schema=schema) as writer:
            for code in ordered_codes:
                arr = driver_arrays[code]
                pa_arrays = []
                for col_name, col_type in DRIVER_COLUMNS.items():
                    values = np.asarray(arr[col_name])
                    if pa.types.is_integer(col_type):
                        if col_name == "lap":
                            values = _as_dtype(np.rint(values), np.int16)
                        elif col_name in ("gear", "drs", "tyre"):
                            values = _as_dtype(np.rint(values), np.int8)
                        elif col_name == "brake":
                            values = _as_dtype((np.asarray(values) > 0.0).astype(np.int8), np.int8)
                        else:
                            values = _as_dtype(np.rint(values), np.uint32)
                    else:
                        values = _as_dtype(values, np.float32)
                    pa_arrays.append(pa.array(values, type=col_type))
                batch = pa.record_batch(pa_arrays, names=list(DRIVER_COLUMNS.keys()))
                t_start = int(arr["t_idx"][0]) if len(arr["t_idx"]) else 0
                t_end = int(arr["t_idx"][-1]) if len(arr["t_idx"]) else 0
                max_lap = int(np.nanmax(arr["lap"])) if len(arr["lap"]) else 0
                md = {
                    b"driver_code": code.encode("utf-8"),
                    b"t_start": str(t_start).encode("utf-8"),
                    b"t_end": str(t_end).encode("utf-8"),
                    b"max_lap": str(max_lap).encode("utf-8"),
                }
                writer.write_batch(batch, custom_metadata=md)
                batch_metadata[code] = {
                    "t_start": t_start,
                    "t_end": t_end,
                    "max_lap": max_lap,
                }

    sidecar = dict(meta)
    sidecar["driver_batch_order"] = ordered_codes
    sidecar["driver_batch_meta"] = batch_metadata
    with tmp_meta.open("w", encoding="utf-8") as f:
        json.dump(sidecar, f, ensure_ascii=True, indent=2)
        f.write("\n")

    tmp_arrow.replace(path)
    tmp_meta.replace(meta_path)


def _round_or_zero(value, ndigits: int = 3):
    if value is None:
        return None
    try:
        if isinstance(value, float) and math.isnan(value):
            return None
    except TypeError:
        return None
    return round(float(value), ndigits)


def build_driver_arrays_from_frames(frames: list[dict], fps: int = FPS_DEFAULT) -> dict[str, dict[str, np.ndarray]]:
    if not frames:
        return {}
    driver_codes = sorted({code for frame in frames for code in frame.get("drivers", {}).keys()})
    n = len(frames)
    driver_arrays: dict[str, dict[str, np.ndarray]] = {}
    for code in driver_codes:
        driver_arrays[code] = {
            "t_idx": np.arange(n, dtype=np.uint32),
            "x": np.zeros(n, dtype=np.float32),
            "y": np.zeros(n, dtype=np.float32),
            "dist": np.zeros(n, dtype=np.float32),
            "rel_dist": np.zeros(n, dtype=np.float32),
            "lap": np.ones(n, dtype=np.int16),
            "speed": np.zeros(n, dtype=np.float32),
            "gear": np.zeros(n, dtype=np.int8),
            "drs": np.zeros(n, dtype=np.int8),
            "throttle": np.zeros(n, dtype=np.float32),
            "brake": np.zeros(n, dtype=np.int8),
            "rpm": np.zeros(n, dtype=np.float32),
            "tyre": np.zeros(n, dtype=np.int8),
            "tyre_life": np.zeros(n, dtype=np.float32),
        }

    for i, frame in enumerate(frames):
        drivers = frame.get("drivers", {})
        for code, arr in driver_arrays.items():
            d = drivers.get(code)
            if not d:
                continue
            arr["x"][i] = float(d.get("x", 0.0))
            arr["y"][i] = float(d.get("y", 0.0))
            arr["dist"][i] = float(d.get("dist", 0.0))
            arr["rel_dist"][i] = float(d.get("rel_dist", 0.0))
            arr["lap"][i] = int(round(d.get("lap", 1)))
            arr["speed"][i] = float(d.get("speed", 0.0))
            arr["gear"][i] = int(round(d.get("gear", 0)))
            arr["drs"][i] = int(round(d.get("drs", 0)))
            arr["throttle"][i] = float(d.get("throttle", 0.0))
            arr["brake"][i] = int(float(d.get("brake", 0.0)) > 0.0)
            arr["rpm"][i] = float(d.get("rpm", 0.0))
            arr["tyre"][i] = int(round(d.get("tyre", 0)))
            arr["tyre_life"][i] = float(d.get("tyre_life", 0.0))

    return driver_arrays


def sparse_weather_from_frames(frames: list[dict], fps: int = FPS_DEFAULT) -> list[dict]:
    if not frames:
        return []
    step = max(1, int(fps * 60))  # per-minute checkpoints
    checkpoints = []
    for i in range(0, len(frames), step):
        weather = frames[i].get("weather") or {}
        if not weather:
            continue
        point = {"frame_idx": i}
        for key in _WEATHER_KEYS:
            point[key] = _round_or_zero(weather.get(key), 4)
        point["rain_state"] = weather.get("rain_state")
        checkpoints.append(point)
    # Include last frame for interpolation bounds.
    last_idx = len(frames) - 1
    if checkpoints and checkpoints[-1]["frame_idx"] != last_idx:
        weather = frames[last_idx].get("weather") or {}
        point = {"frame_idx": last_idx}
        for key in _WEATHER_KEYS:
            point[key] = _round_or_zero(weather.get(key), 4)
        point["rain_state"] = weather.get("rain_state")
        checkpoints.append(point)
    return checkpoints


def sparse_safety_car_from_frames(frames: list[dict]) -> list[dict]:
    events = []
    for i, frame in enumerate(frames):
        sc = frame.get("safety_car")
        if not sc:
            continue
        events.append({
            "frame_idx": i,
            "x": _round_or_zero(sc.get("x"), 3),
            "y": _round_or_zero(sc.get("y"), 3),
            "phase": sc.get("phase"),
            "alpha": _round_or_zero(sc.get("alpha"), 4),
        })
    return events


def build_meta_from_pickle_payload(payload: dict, fps: int = FPS_DEFAULT) -> dict:
    frames = payload.get("frames") or []
    driver_codes = sorted({code for f in frames for code in f.get("drivers", {})})
    return {
        "schema_version": 1,
        "fps": int(fps),
        "timeline_t0": 0.0,
        "frame_count": len(frames),
        "total_laps": int(payload.get("total_laps", 0)),
        "driver_codes": driver_codes,
        "driver_colors": payload.get("driver_colors", {}),
        "telemetry_ranges": payload.get("telemetry_ranges", {}),
        "max_tyre_life": payload.get("max_tyre_life", {}),
        "track_statuses": payload.get("track_statuses", []),
        "race_control_messages": payload.get("race_control_messages", []),
        "weather_per_minute": sparse_weather_from_frames(frames, fps=fps),
        "safety_car_events": sparse_safety_car_from_frames(frames),
    }


def migrate_pickle_payload_to_arrow(payload: dict, arrow_path: Path, fps: int = FPS_DEFAULT) -> Path:
    frames = payload.get("frames") or []
    driver_arrays = build_driver_arrays_from_frames(frames, fps=fps)
    meta = build_meta_from_pickle_payload(payload, fps=fps)
    write_race(arrow_path, driver_arrays, meta)
    return Path(arrow_path).with_suffix(".arrow")


def migrate_pickle_file_to_arrow(pickle_path: Path, arrow_path: Path | None = None, fps: int = FPS_DEFAULT) -> Path:
    import pickle

    pickle_path = Path(pickle_path)
    if arrow_path is None:
        arrow_path = pickle_path.with_suffix("").with_suffix("").with_suffix(".arrow")
    with pickle_path.open("rb") as f:
        payload = pickle.load(f)
    return migrate_pickle_payload_to_arrow(payload, Path(arrow_path), fps=fps)


class RaceHandle:
    def __init__(self, arrow_path: Path):
        self.arrow_path = Path(arrow_path)
        if self.arrow_path.suffix != ".arrow":
            self.arrow_path = self.arrow_path.with_suffix(".arrow")
        self.meta_path = _meta_path_for_arrow(self.arrow_path)
        self.meta = json.loads(self.meta_path.read_text(encoding="utf-8"))
        self.fps = int(self.meta.get("fps", FPS_DEFAULT))
        self.frame_count = int(self.meta.get("frame_count", 0))
        self._driver_codes = list(self.meta.get("driver_batch_order", self.meta.get("driver_codes", [])))

        self._mmap = pa.memory_map(str(self.arrow_path), "r")
        self._reader = pa.ipc.open_file(self._mmap)

        self._driver_arrays: dict[str, dict[str, np.ndarray]] = {}
        for i, code in enumerate(self._driver_codes):
            batch = self._reader.get_batch(i)
            arrs = {}
            for col in DRIVER_COLUMNS.keys():
                idx = batch.schema.get_field_index(col)
                arrs[col] = batch.column(idx).to_numpy(zero_copy_only=False)
            self._driver_arrays[code] = arrs

        self._weather = self.meta.get("weather_per_minute", []) or []
        self._weather_idx = [int(w["frame_idx"]) for w in self._weather]
        self._safety_car_by_idx = {
            int(e["frame_idx"]): {
                "x": float(e.get("x", 0.0)),
                "y": float(e.get("y", 0.0)),
                "phase": e.get("phase"),
                "alpha": float(e.get("alpha", 0.0)),
            }
            for e in (self.meta.get("safety_car_events", []) or [])
        }

    def _interpolate_weather(self, frame_idx: int) -> dict:
        if not self._weather:
            return {}
        pos = bisect_right(self._weather_idx, frame_idx)
        if pos <= 0:
            w = self._weather[0]
            return {k: w.get(k) for k in _WEATHER_KEYS if w.get(k) is not None} | {"rain_state": w.get("rain_state")}
        if pos >= len(self._weather):
            w = self._weather[-1]
            return {k: w.get(k) for k in _WEATHER_KEYS if w.get(k) is not None} | {"rain_state": w.get("rain_state")}

        left = self._weather[pos - 1]
        right = self._weather[pos]
        li = int(left["frame_idx"])
        ri = int(right["frame_idx"])
        alpha = 0.0 if ri == li else (frame_idx - li) / float(ri - li)
        out = {}
        for k in _WEATHER_KEYS:
            lv = left.get(k)
            rv = right.get(k)
            if lv is None and rv is None:
                continue
            if lv is None:
                out[k] = float(rv)
            elif rv is None:
                out[k] = float(lv)
            else:
                out[k] = float(lv) + (float(rv) - float(lv)) * alpha
        rain_state = left.get("rain_state") if alpha < 0.5 else right.get("rain_state")
        if rain_state is not None:
            out["rain_state"] = rain_state
        return out

    def frame_at(self, frame_idx: int) -> dict:
        if self.frame_count <= 0:
            return {"t": 0.0, "lap": 1, "drivers": {}}
        idx = int(max(0, min(frame_idx, self.frame_count - 1)))
        drivers = {}
        leader_lap = 1
        for code in self._driver_codes:
            arr = self._driver_arrays[code]
            lap = int(arr["lap"][idx])
            leader_lap = max(leader_lap, lap)
            drivers[code] = {
                "x": float(arr["x"][idx]),
                "y": float(arr["y"][idx]),
                "dist": float(arr["dist"][idx]),
                "rel_dist": float(arr["rel_dist"][idx]),
                "lap": lap,
                "speed": float(arr["speed"][idx]),
                "gear": int(arr["gear"][idx]),
                "drs": int(arr["drs"][idx]),
                "throttle": float(arr["throttle"][idx]),
                "brake": int(arr["brake"][idx]),
                "rpm": float(arr["rpm"][idx]),
                "tyre": int(arr["tyre"][idx]),
                "tyre_life": float(arr["tyre_life"][idx]),
            }

        frame = {
            "t": round(idx / float(self.fps), 3),
            "lap": leader_lap,
            "drivers": drivers,
        }
        weather = self._interpolate_weather(idx)
        if weather:
            frame["weather"] = weather
        sc = self._safety_car_by_idx.get(idx)
        if sc is not None:
            frame["safety_car"] = sc
        return frame

    def frames_iter(self, start: int, stop: int) -> Iterable[dict]:
        s = max(0, int(start))
        e = min(int(stop), self.frame_count)
        for idx in range(s, e):
            yield self.frame_at(idx)

    def column(self, driver_code: str, name: str) -> np.ndarray:
        if driver_code not in self._driver_arrays:
            raise KeyError(f"Unknown driver code '{driver_code}'")
        if name not in self._driver_arrays[driver_code]:
            raise KeyError(f"Unknown column '{name}'")
        return self._driver_arrays[driver_code][name]
