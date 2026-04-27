// Right-side panels: tyre strategy, pit predictor, ghost radar, etc.

const { TEAMS, COMPOUNDS, DRIVERS, getStints, getPitStops } = window.APEX;
const FALLBACK_TEAM_COLOR = "#9AA3B2";
const FALLBACK_COMPOUND_COLOR = "#FFD93A";

function isOutOfPlayStanding(s) {
  const badge = String(s?.labelStatus || "").trim().toUpperCase();
  return s?.status === "OUT" || badge === "RET" || badge === "ACC";
}

// Map fastf1 compound strings → APEX keys
const COMPOUND_KEY = {
  SOFT: "S", MEDIUM: "M", HARD: "H",
  INTERMEDIATE: "I", WET: "W", UNKNOWN: "M",
};

// Stint strategy strip for top-10 drivers — uses real stint & pit stop data
function StrategyStrip({ standings, totalLaps, lap }) {
  const T = window.THEME;
  const top = standings.slice(0, 10);
  return (
    <div className="apex-panel-mount" style={{
      background: T.surface,
      border: T.border,
      overflow: "hidden",
    }}>
      <PanelHeader title="TYRE STRATEGY" meta={`LAP ${lap}/${totalLaps}`}/>
      <div style={{ padding: "6px 10px", fontFamily: T.mono }}>
        {top.map((s) => {
          const team = TEAMS[s.driver.team] || {
            name: s.driver.team || "Unknown",
            color: FALLBACK_TEAM_COLOR,
          };
          const rawStints = getStints(s.driver.code);
          const pitStops = getPitStops(s.driver.code);
          // Convert real stints → { start, end, c } for rendering
          const stops = rawStints.length > 0
            ? rawStints.map((st) => ({
                start: st.start_lap - 1,   // 0-indexed for bar positioning
                end: st.end_lap,
                c: COMPOUND_KEY[st.compound] || "M",
              }))
            : [{ start: 0, end: totalLaps, c: "M" }]; // fallback
          return (
            <div key={s.driver.code} style={{
              display: "grid", gridTemplateColumns: "28px 36px 1fr",
              gap: 8, alignItems: "center",
              padding: "3px 0",
              fontSize: T.fs.xs,
            }}>
              <div style={{ color: T.textDim, fontVariantNumeric: "tabular-nums" }}>
                P{String(s.pos).padStart(2, "0")}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 2, height: 10, background: team.color }}/>
                <div style={{ color: T.text, fontWeight: 700, letterSpacing: T.ls.body }}>{s.driver.code}</div>
              </div>
              <div style={{ position: "relative", height: 10, background: "rgba(255,255,255,0.04)" }}>
                {stops.map((stint, i) => {
                  const sx = (stint.start / totalLaps) * 100;
                  const sw = ((stint.end - stint.start) / totalLaps) * 100;
                  return (
                    <div key={i} style={{
                      position: "absolute", left: `${sx}%`, width: `${sw}%`, top: 0, bottom: 0,
                      background: COMPOUNDS[stint.c]?.color || COMPOUNDS.M?.color || FALLBACK_COMPOUND_COLOR,
                      opacity: stint.end < lap ? 0.55 : stint.start > lap ? 0.25 : 0.85,
                      borderRight: "1px solid rgba(11,11,17,0.7)",
                    }}/>
                  );
                })}
                {/* Pit stop markers */}
                {pitStops.map((ps, i) => (
                  <div key={`pit-${i}`} style={{
                    position: "absolute",
                    left: `${(ps.lap / totalLaps) * 100}%`,
                    top: -3, bottom: -3, width: 2,
                    background: T.caution,
                    borderRadius: 1,
                    zIndex: 2,
                  }}/>
                ))}
                {/* Current lap marker */}
                <div style={{
                  position: "absolute", left: `${(lap / totalLaps) * 100}%`,
                  top: -2, bottom: -2, width: 1, background: "#FFFFFF",
                  zIndex: 3,
                }}/>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Compact gap-to-leader visualizer (spider)
function GapViz({ standings, pinned }) {
  const T = window.THEME;
  const running = React.useMemo(
    () => standings.filter((s) => !isOutOfPlayStanding(s)),
    [standings],
  );
  const top = running.slice(0, 10);
  const maxGap = Math.max(...top.map((s) => s.gap ?? 0), 1);
  return (
    <div className="apex-panel-mount" style={{
      background: T.surface,
      border: T.border,
    }}>
      <PanelHeader title="GAP TO LEADER"/>
      <div style={{ padding: "6px 10px", fontFamily: T.mono }}>
        {top.map((s) => {
          const team = TEAMS[s.driver.team] || {
            name: s.driver.team || "Unknown",
            color: FALLBACK_TEAM_COLOR,
          };
          const gap = s.gap ?? 0;
          const pct = (gap / maxGap) * 100;
          const isPinned = pinned === s.driver.code;
          return (
            <div key={s.driver.code} style={{
              display: "grid", gridTemplateColumns: "40px 1fr 58px",
              gap: 6, alignItems: "center", fontSize: T.fs.xs,
              padding: "2.5px 0",
            }}>
              <div style={{ color: isPinned ? T.hot : T.text, fontWeight: 700 }}>
                {s.driver.code}
              </div>
              <div style={{ position: "relative", height: 3, background: "rgba(255,255,255,0.04)" }}>
                <div style={{ position: "absolute", left: 0, width: `${pct}%`, height: "100%", background: team.color }}/>
              </div>
              <div style={{ color: "rgba(230,230,239,0.8)", fontVariantNumeric: "tabular-nums", textAlign: "right" }}>
                {s.pos === 1 ? "LEADER" : `+${gap.toFixed(2)}`}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Event feed / race control messages
function RaceFeed({ events }) {
  const T = window.THEME;
  return (
    <div className="apex-panel-mount" style={{
      background: T.surface,
      border: T.border,
      display: "flex", flexDirection: "column",
      minHeight: 0, flex: 1,
    }}>
      <PanelHeader title="RACE CONTROL" meta={`${events.length} MSGS`}/>
      <div style={{ overflow: "auto", flex: 1, fontFamily: T.mono, fontSize: T.fs.sm }}>
        {events.map((e, i) => (
          <div key={i} style={{
            display: "grid", gridTemplateColumns: "54px 42px 1fr",
            gap: 8, padding: "6px 10px",
            borderBottom: "1px solid rgba(255,255,255,0.03)",
            alignItems: "start",
          }}>
            <div style={{ color: T.textDim, fontSize: T.fs.xs, fontVariantNumeric: "tabular-nums" }}>
              {e.time}
            </div>
            <div style={{
              fontSize: 8, letterSpacing: T.ls.caps, fontWeight: 700,
              padding: "1px 4px",
              color: e.tag === "SC" ? "#0B0B11" : e.tag === "FLAG" ? "#0B0B11" : T.text,
              background: e.tag === "SC" ? T.caution : e.tag === "FLAG" ? T.warn : e.tag === "INFO" ? "rgba(255,255,255,0.06)" : "rgba(255,30,0,0.3)",
              textAlign: "center",
              alignSelf: "start",
            }}>
              {e.tag}
            </div>
            <div style={{ color: T.text, fontSize: T.fs.sm, lineHeight: 1.35, letterSpacing: T.ls.tight }}>
              {e.msg}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

window.StrategyStrip = StrategyStrip;
window.GapViz = GapViz;
window.RaceFeed = RaceFeed;
