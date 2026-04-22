from bisect import bisect_right

FLAG_MAP = {"1": "green", "2": "yellow", "4": "sc", "5": "red", "6": "vsc", "7": "vsc"}


class FlagBisect:
    """Bisect into the sparse track_statuses mapping to find the active flag."""

    def __init__(self, track_statuses: dict):
        # track_statuses from get_race_telemetry is a list of dicts:
        #   [{"status": "1", "start_time": ..., "end_time": ...}, ...]
        # We convert to frame-index keys if possible, otherwise time-based.
        # For the web server we store frame_index -> status_code.
        items = sorted((int(k), str(v)) for k, v in track_statuses.items())
        self._keys = [k for k, _ in items]
        self._vals = [v for _, v in items]

    def at(self, frame_index: int) -> str:
        if not self._keys:
            return "green"
        i = bisect_right(self._keys, frame_index) - 1
        if i < 0:
            return "green"
        return FLAG_MAP.get(self._vals[i], "green")


class FlagBisectByTime:
    """Bisect by race time (seconds) into track_statuses list from get_race_telemetry."""

    def __init__(self, track_statuses_list: list):
        # track_statuses_list is [{"status": "1", "start_time": float, "end_time": float|None}, ...]
        self._entries = sorted(track_statuses_list, key=lambda e: e["start_time"])

    def at(self, t_seconds: float) -> str:
        active = "1"  # default green
        for entry in self._entries:
            if t_seconds >= entry["start_time"] and (
                entry.get("end_time") is None or t_seconds <= entry["end_time"]
            ):
                active = entry["status"]
        return FLAG_MAP.get(active, "green")
