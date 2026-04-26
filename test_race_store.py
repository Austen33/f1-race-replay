from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

from src.data.race_store import RaceHandle, write_race


def test_write_race_roundtrip_preserves_drs_raw():
    with TemporaryDirectory() as td:
        out = Path(td) / "mini_R.arrow"
        driver_arrays = {
            "AAA": {
                "t_idx": np.array([0, 1, 2], dtype=np.uint32),
                "x": np.array([1.0, 2.0, 3.0], dtype=np.float32),
                "y": np.array([4.0, 5.0, 6.0], dtype=np.float32),
                "dist": np.array([10.0, 20.0, 30.0], dtype=np.float32),
                "rel_dist": np.array([0.1, 0.2, 0.3], dtype=np.float32),
                "lap": np.array([1, 1, 1], dtype=np.int16),
                "speed": np.array([150.0, 151.0, 152.0], dtype=np.float32),
                "gear": np.array([6, 7, 8], dtype=np.int8),
                "drs": np.array([0, 10, 14], dtype=np.int8),
                "throttle": np.array([80.0, 81.0, 82.0], dtype=np.float32),
                "brake": np.array([0, 1, 0], dtype=np.int8),
                "rpm": np.array([11000.0, 11500.0, 11800.0], dtype=np.float32),
                "tyre": np.array([2, 2, 2], dtype=np.int8),
                "tyre_life": np.array([3.0, 3.1, 3.2], dtype=np.float32),
            }
        }
        meta = {
            "schema_version": 1,
            "fps": 60,
            "frame_count": 3,
            "total_laps": 1,
            "driver_codes": ["AAA"],
            "driver_colors": {"AAA": [255, 0, 0]},
            "track_statuses": [],
            "race_control_messages": [],
            "weather_per_minute": [],
            "safety_car_events": [],
            "telemetry_ranges": {},
            "max_tyre_life": {},
        }
        write_race(out, driver_arrays, meta)

        handle = RaceHandle(out)
        frame0 = handle.frame_at(0)
        frame1 = handle.frame_at(1)
        frame2 = handle.frame_at(2)

        assert frame0["drivers"]["AAA"]["drs"] == 0
        assert frame1["drivers"]["AAA"]["drs"] == 10
        assert frame2["drivers"]["AAA"]["drs"] == 14
