// Leaderboard — left rail. Engineer-dense.

const { TEAMS, COMPOUNDS } = window.APEX;

function fmtGap(g) {
  if (g === 0) return "LEADER";
  if (g < 60) return `+${g.toFixed(3)}`;
  const m = Math.floor(g / 60);
  const s = (g % 60).toFixed(3);
  return `+${m}:${s.padStart(6, "0")}`;
}
function fmtInterval(g) {
  if (g === 0) return "—";
  return `+${g.toFixed(3)}`;
}
function fmtLap(t) {
  if (!t) return "—";
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(3);
  return `${m}:${s.padStart(6, "0")}`;
}

function Leaderboard({ standings, pinned, secondary, onPick, onShiftPick, bestLapCode }) {
  return (
    <div style={{
      background: "linear-gradient(180deg, rgba(20,20,30,0.92) 0%, rgba(11,11,17,0.94) 100%)",
      border: "1px solid rgba(255,255,255,0.06)",
      borderRadius: 2,
      backdropFilter: "blur(8px)",
      display: "flex", flexDirection: "column",
      height: "100%",
      overflow: "hidden",
    }}>
      <PanelHeader title="CLASSIFICATION" meta={`${standings.filter(s => s.status !== "OUT").length}/20 CARS`} />
      <div style={{
        display: "grid",
        gridTemplateColumns: "24px 26px 1fr 62px 62px 58px 22px",
        gap: 6, padding: "6px 10px",
        fontFamily: "JetBrains Mono, monospace",
        fontSize: 9,
        color: "rgba(180,180,200,0.5)",
        letterSpacing: "0.1em",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
      }}>
        <div>P</div><div></div><div>DRIVER</div><div style={{textAlign:"right"}}>GAP</div><div style={{textAlign:"right"}}>INT</div><div style={{textAlign:"right"}}>LAST</div><div></div>
      </div>
      <div style={{ overflow: "auto", flex: 1 }}>
        {standings.map((s) => {
          const team = TEAMS[s.driver.team];
          const isPinned = pinned === s.driver.code;
          const isSec = secondary === s.driver.code;
          const isOut = s.status === "OUT";
          const isBest = bestLapCode === s.driver.code;
          return (
            <div
              key={s.driver.code}
              onClick={(e) => {
                if (e.shiftKey) onShiftPick(s.driver.code);
                else onPick(s.driver.code);
              }}
              style={{
                display: "grid",
                gridTemplateColumns: "24px 26px 1fr 62px 62px 58px 22px",
                gap: 6,
                padding: "5px 10px",
                alignItems: "center",
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 11,
                color: isOut ? "rgba(180,180,200,0.35)" : "#E6E6EF",
                cursor: "pointer",
                borderLeft: isPinned ? "2px solid #FF1E00" : isSec ? "2px solid #00D9FF" : "2px solid transparent",
                background: isPinned
                  ? "linear-gradient(90deg, rgba(255,30,0,0.12), transparent 60%)"
                  : isSec
                  ? "linear-gradient(90deg, rgba(0,217,255,0.12), transparent 60%)"
                  : "transparent",
                borderBottom: "1px solid rgba(255,255,255,0.03)",
                transition: "background 100ms",
              }}
              onMouseEnter={(e) => { if (!isPinned && !isSec) e.currentTarget.style.background = "rgba(255,255,255,0.03)"; }}
              onMouseLeave={(e) => { if (!isPinned && !isSec) e.currentTarget.style.background = "transparent"; }}
            >
              <div style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                {String(s.pos).padStart(2, " ")}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 3, height: 14, background: team.color }}/>
                <div style={{ fontSize: 9, color: "rgba(180,180,200,0.55)" }}>{s.driver.num}</div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
                <div style={{ fontWeight: 700, letterSpacing: "0.04em" }}>{s.driver.code}</div>
                <div style={{ fontSize: 8, color: "rgba(180,180,200,0.45)", letterSpacing: "0.08em" }}>{team.name}</div>
              </div>
              <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 10, color: isOut ? "inherit" : "rgba(230,230,239,0.85)" }}>
                {isOut ? "DNF" : fmtGap(s.gap)}
              </div>
              <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 10, color: "rgba(180,180,200,0.6)" }}>
                {isOut ? "—" : fmtInterval(s.interval)}
              </div>
              <div style={{
                textAlign: "right",
                fontVariantNumeric: "tabular-nums",
                fontSize: 10,
                color: (() => {
                  if (isBest) return "#C15AFF";
                  if (s.lastLap > 0 && s.pbLap > 0 && s.lastLap === s.pbLap) return "#1EFF6A";
                  if (s.lastLap > 0 && s.pbLap > 0 && s.lastLap < s.pbLap + 0.2) return "#FFD93A";
                  return "rgba(230,230,239,0.75)";
                })(),
              }}>
                {isOut ? "—" : fmtLap(s.lastLap)}
              </div>
              <TyrePip compound={s.compound} age={s.tyreAge} pit={s.pit} out={isOut}/>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TyrePip({ compound, age, pit, out }) {
  if (out) return <div/>;
  const c = COMPOUNDS[compound];
  return (
    <div title={`${c.label} · ${age} laps${pit ? " · PIT" : ""}`} style={{
      width: 18, height: 18, position: "relative",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <svg width="18" height="18" viewBox="0 0 18 18">
        <circle cx="9" cy="9" r="7" fill="none" stroke={c.color} strokeWidth="2"/>
        <circle cx="9" cy="9" r="2.5" fill={c.color}/>
      </svg>
      {pit && (
        <div style={{
          position: "absolute", top: -2, right: -2,
          width: 6, height: 6, borderRadius: 3,
          background: "#FF1E00",
          boxShadow: "0 0 4px #FF1E00",
        }}/>
      )}
    </div>
  );
}

function PanelHeader({ title, meta, accent = "#FF1E00" }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "10px 12px",
      borderBottom: "1px solid rgba(255,255,255,0.06)",
      fontFamily: "JetBrains Mono, monospace",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 6, height: 6, background: accent, boxShadow: `0 0 6px ${accent}` }}/>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.18em", color: "#E6E6EF" }}>
          {title}
        </div>
      </div>
      {meta && (
        <div style={{ fontSize: 9, color: "rgba(180,180,200,0.6)", letterSpacing: "0.1em" }}>
          {meta}
        </div>
      )}
    </div>
  );
}

window.Leaderboard = Leaderboard;
window.PanelHeader = PanelHeader;
