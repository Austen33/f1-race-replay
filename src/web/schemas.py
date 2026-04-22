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
    rpm: float


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
