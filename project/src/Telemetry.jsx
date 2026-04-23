// Telemetry panels — right rail + driver card + compare view.

const { TEAMS, COMPOUNDS, DRIVERS, lapTrace } = window.APEX;

function DriverCard({ code, data, accent, secondary = false, standings = [] }) {
  const T = window.THEME;
  const a = accent || T.accent;
  if (!code) {
    return (
      <div className="apex-panel-mount" style={{
        padding: 16, minHeight: 120,
        fontFamily: T.mono,
        fontSize: T.fs.sm, color: T.textFaint,
        letterSpacing: T.ls.caps,
        display: "flex", alignItems: "center", justifyContent: "center",
        border: "1px dashed rgba(255,255,255,0.08)",
      }}>
        SELECT DRIVER ON TRACK OR LEADERBOARD
      </div>
    );
  }
  const d = DRIVERS.find((x) => x.code === code);
  if (!d) {
    return (
      <div className="apex-panel-mount" style={{
        padding: 16, minHeight: 120,
        fontFamily: T.mono,
        fontSize: T.fs.sm, color: T.textFaint,
        letterSpacing: T.ls.caps,
        display: "flex", alignItems: "center", justifyContent: "center",
        border: "1px dashed rgba(255,255,255,0.08)",
      }}>
        SELECT DRIVER ON TRACK OR LEADERBOARD
      </div>
    );
  }
  const team = TEAMS[d.team];
  const live = standings.find(s => s.driver.code === code);
  const compoundKey = live?.compound || "M";
  const compound = COMPOUNDS[compoundKey];
  return (
    <div className="apex-panel-mount" style={{
      background: T.surface,
      border: secondary ? T.borderCool : T.borderHot,
      position: "relative",
      overflow: "hidden",
    }}>
      {/* Top accent slab */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: a }}/>

      <div style={{
        display: "grid", gridTemplateColumns: "38px 1fr auto",
        gap: 10, padding: "10px 12px",
        borderBottom: T.borderSoft,
        alignItems: "center",
      }}>
        <div style={{
          width: 38, height: 38,
          background: team.color,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: T.mono,
          fontSize: T.fs.lg, fontWeight: 800,
          color: team.color === "#FFFFFF" || team.color === "#FFD700" ? "#0B0B11" : "#FFFFFF",
          position: "relative",
        }}>
          {d.num}
          <div style={{ position: "absolute", inset: 0, background: "linear-gradient(135deg, rgba(255,255,255,0.2), transparent 50%)" }}/>
        </div>
        <div style={{ fontFamily: T.mono, lineHeight: 1.2 }}>
          <div style={{ fontSize: T.fs.lg, fontWeight: 700, color: T.text, letterSpacing: T.ls.body }}>
            {d.code} <span style={{ color: T.textFaint, fontWeight: 400, fontSize: T.fs.md }}>· {d.name}</span>
          </div>
          <div style={{ fontSize: T.fs.xs, color: team.color, letterSpacing: T.ls.caps, fontWeight: 700 }}>
            {team.name}
          </div>
        </div>
        <div style={{ fontFamily: T.mono, fontSize: T.fs.xs, color: T.textDim, textAlign: "right", letterSpacing: T.ls.label }}>
          {d.country}
        </div>
      </div>

      <div style={{ padding: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <BigReadout label="SPEED" value={data.speed} unit="kph" accent={a}/>
        <BigReadout label="GEAR"  value={data.gear}  unit="" accent={a}/>
      </div>

      <div style={{ padding: "0 12px 10px" }}>
        <Bar label="THR" value={data.throttle} color={T.good}/>
        <Bar label="BRK" value={data.brake}   color={T.hot}/>
      </div>

      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
        borderTop: T.borderSoft,
      }}>
        <MicroStat label="RPM" value={data.rpm.toLocaleString()} />
        <MicroStat label="DRS" value={data.drs ? "OPEN" : "CLSD"} strong={data.drs} color={data.drs ? T.good : undefined}/>
        <MicroStat label="TYRE" value={`${compound.label.slice(0,3).toUpperCase()} · ${live?.tyreAge ?? 0}L`} color={compound.color}/>
      </div>
    </div>
  );
}

function BigReadout({ label, value, unit, accent }) {
  const T = window.THEME;
  return (
    <div style={{ fontFamily: T.mono }}>
      <div style={{ fontSize: T.fs.xs, color: T.textDim, letterSpacing: T.ls.caps, marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
        <div style={{
          fontSize: T.fs.xl, fontWeight: 700, color: T.textStrong,
          fontVariantNumeric: "tabular-nums", letterSpacing: T.ls.tight,
          lineHeight: 1,
          textShadow: `0 0 18px ${accent}44`,
        }}>
          {value}
        </div>
        {unit && (
          <div style={{ fontSize: T.fs.sm, color: T.textDim, letterSpacing: T.ls.label }}>
            {unit}
          </div>
        )}
      </div>
    </div>
  );
}

function Bar({ label, value, color, max = 100, dim }) {
  const T = window.THEME;
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "34px 1fr 32px",
      gap: 8, alignItems: "center",
      fontFamily: T.mono,
      fontSize: T.fs.xs,
      padding: "3px 0",
      opacity: dim ? 0.35 : 1,
    }}>
      <div style={{ color: T.textMuted, letterSpacing: T.ls.label }}>{label}</div>
      <div style={{ height: 6, background: "rgba(255,255,255,0.05)", position: "relative" }}>
        <div style={{
          position: "absolute", inset: 0, width: `${pct}%`,
          background: color,
          boxShadow: `0 0 6px ${color}66`,
        }}/>
        {/* tick marks */}
        {[25, 50, 75].map((t) => (
          <div key={t} style={{ position: "absolute", left: `${t}%`, top: 0, bottom: 0, width: 1, background: "rgba(11,11,17,0.8)" }}/>
        ))}
      </div>
      <div style={{ color: T.text, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>
        {Math.round(value)}
      </div>
    </div>
  );
}

function MicroStat({ label, value, color, strong }) {
  const T = window.THEME;
  return (
    <div style={{
      padding: "8px 10px",
      borderRight: "1px solid rgba(255,255,255,0.04)",
      fontFamily: T.mono,
    }}>
      <div style={{ fontSize: T.fs.xs, color: T.textDim, letterSpacing: T.ls.caps }}>{label}</div>
      <div style={{
        fontSize: T.fs.md, fontWeight: strong ? 700 : 600,
        color: color || T.text,
        fontVariantNumeric: "tabular-nums",
        marginTop: 2,
      }}>
        {value}
      </div>
    </div>
  );
}

// Compare lap-distance traces for 1-2 drivers
function CompareTraces({ pinned, secondary, lap, channel = "speed", setChannel, tWithinLap }) {
  const T = window.THEME;
  const codes = [pinned, secondary].filter(Boolean);
  const traces = codes.map((c) => lapTrace(c, lap, channel));
  const hasData = traces.some((t) => t.length > 0);
  const W = 480, H = 140, PAD_L = 30, PAD_B = 18, PAD_T = 10, PAD_R = 8;
  const iw = W - PAD_L - PAD_R, ih = H - PAD_T - PAD_B;
  const all = traces.flat();
  const minRaw = all.length > 0 ? Math.min(...all.map((p) => p.value)) : 0;
  const maxRaw = all.length > 0 ? Math.max(...all.map((p) => p.value)) : 100;
  const padAbs = Math.max(1, (maxRaw - minRaw) * 0.05);
  const min = minRaw - padAbs;
  const max = maxRaw + padAbs;
  const span = Math.max(1e-6, max - min);
  const colors = [T.hot, T.cool];

  const pathFor = (t) => {
    if (!t || t.length === 0) return "";
    let d = "";
    for (let i = 0; i < t.length; i++) {
      const x = PAD_L + t[i].fraction * iw;
      const y = PAD_T + ih - ((t[i].value - min) / span) * ih;
      d += (i === 0 ? "M" : "L") + ` ${x.toFixed(1)} ${y.toFixed(1)} `;
    }
    return d;
  };

  return (
    <div className="apex-panel-mount" style={{
      background: T.surface,
      border: T.border,
      overflow: "hidden",
    }}>
      <PanelHeader title={`TRACE · ${channel.toUpperCase()}`} meta={`LAP ${lap}`} />
      <div style={{ position: "relative" }}>
        {!hasData && (
          <div style={{
            position: "absolute", top: 8, right: 10,
            fontFamily: T.mono,
            fontSize: T.fs.xs, fontWeight: 700,
            letterSpacing: T.ls.caps,
            color: T.textFaint,
            padding: "1px 4px",
            border: "1px solid rgba(255,255,255,0.08)",
            zIndex: 2,
          }}>WAIT</div>
        )}
        <div style={{
          position: "absolute", top: 6, left: 120,
          display: "flex", gap: 4,
          zIndex: 2,
        }}>
          {["speed","throttle","brake"].map((ch) => (
            <button key={ch} onClick={() => setChannel && setChannel(ch)} style={{
              padding: "2px 6px",
              background: channel === ch ? T.hot : "transparent",
              color: channel === ch ? "#FFFFFF" : T.textMuted,
              border: `1px solid ${channel === ch ? T.hot : "rgba(255,255,255,0.08)"}`,
              fontFamily: T.mono,
              fontSize: 8, letterSpacing: T.ls.caps, fontWeight: 700,
              cursor: "pointer",
            }}>{ch.toUpperCase()}</button>
          ))}
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none">
          {/* Grid */}
          {[0, 0.25, 0.5, 0.75, 1].map((g, i) => (
            <line key={i}
              x1={PAD_L} x2={W - PAD_R}
              y1={PAD_T + g * ih} y2={PAD_T + g * ih}
              stroke="rgba(255,255,255,0.05)" strokeWidth="1"/>
          ))}
          {/* Sector dividers */}
          {[0.33, 0.66].map((s, i) => (
            <line key={i}
              x1={PAD_L + iw * s} x2={PAD_L + iw * s}
              y1={PAD_T} y2={PAD_T + ih}
              stroke="rgba(255,255,255,0.08)" strokeDasharray="2 3"/>
          ))}
          {/* Axis labels */}
          <text x={PAD_L - 4} y={PAD_T + 4} fontFamily={T.mono} fontSize="8" fill="rgba(180,180,200,0.45)" textAnchor="end">{Math.round(max)}</text>
          <text x={PAD_L - 4} y={PAD_T + ih} fontFamily={T.mono} fontSize="8" fill="rgba(180,180,200,0.45)" textAnchor="end">{Math.round(min)}</text>
          <text x={PAD_L} y={H - 4} fontFamily={T.mono} fontSize="8" fill="rgba(180,180,200,0.45)">S1</text>
          <text x={PAD_L + iw * 0.33 + 4} y={H - 4} fontFamily={T.mono} fontSize="8" fill="rgba(180,180,200,0.45)">S2</text>
          <text x={PAD_L + iw * 0.66 + 4} y={H - 4} fontFamily={T.mono} fontSize="8" fill="rgba(180,180,200,0.45)">S3</text>

          {/* Traces */}
          {traces.map((t, i) => (
            <g key={codes[i]}>
              <path d={pathFor(t)} fill="none" stroke={colors[i]} strokeWidth="1.6" strokeLinejoin="round"/>
            </g>
          ))}
          {/* Playhead */}
          {tWithinLap != null && (
            <line
              x1={PAD_L + tWithinLap * iw}
              x2={PAD_L + tWithinLap * iw}
              y1={PAD_T}
              y2={PAD_T + ih}
              stroke={T.hot}
              strokeWidth="1.5"
              strokeDasharray="3 2"
              opacity="0.85"
            />
          )}
        </svg>
        <div style={{
          position: "absolute", top: 24, right: 10,
          display: "flex", gap: 10,
          fontFamily: T.mono,
          fontSize: T.fs.xs,
        }}>
          {codes.map((c, i) => (
            <div key={c} style={{ color: colors[i], letterSpacing: T.ls.label }}>
              ■ {c}
            </div>
          ))}
          {codes.length === 0 && (
            <div style={{ color: T.textFaint }}>NO DRIVER PINNED</div>
          )}
        </div>
      </div>
    </div>
  );
}

// Sector mini-table
function SectorTimes({ pinned, secondary, lap, standings }) {
  const T = window.THEME;
  const primary = standings.find(s => s.driver.code === pinned);
  const secondaryEntry = standings.find(s => s.driver.code === secondary);
  const best = window.APEX.getSessionBest();

  const fmtSector = (val) => {
    if (val == null || val === 0) return "--:---";
    return val.toFixed(3);
  };

  const rows = [
    primary && { code: primary.driver.code, color: T.hot, s1: primary.lastS1, s2: primary.lastS2, s3: primary.lastS3, pbS1: primary.pbS1, pbS2: primary.pbS2, pbS3: primary.pbS3 },
    secondaryEntry && { code: secondaryEntry.driver.code, color: T.cool, s1: secondaryEntry.lastS1, s2: secondaryEntry.lastS2, s3: secondaryEntry.lastS3, pbS1: secondaryEntry.pbS1, pbS2: secondaryEntry.pbS2, pbS3: secondaryEntry.pbS3 },
    best && (best.s1_s != null || best.s2_s != null || best.s3_s != null) && { code: "BEST", color: T.purple, s1: best.s1_s, s2: best.s2_s, s3: best.s3_s },
  ].filter(Boolean);

  const sectorColor = (val, pb, bestVal) => {
    if (val == null || val === 0) return T.text;
    if (pb != null && val === pb && bestVal != null && val === bestVal) return T.purple;
    if (pb != null && val === pb) return T.good;
    return T.text;
  };

  return (
    <div className="apex-panel-mount" style={{
      background: T.surface,
      border: T.border,
    }}>
      <PanelHeader title="SECTOR SPLITS" />
      <div style={{ padding: "8px 12px", fontFamily: T.mono, fontSize: T.fs.sm }}>
        <div style={{ display: "grid", gridTemplateColumns: "36px 1fr 1fr 1fr 1fr", gap: 6, color: T.textDim, fontSize: T.fs.xs, letterSpacing: T.ls.label, paddingBottom: 4, borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
          <div>DRV</div><div>S1</div><div>S2</div><div>S3</div><div>TOTAL</div>
        </div>
        {rows.length === 0 && (
          <div style={{ padding: "14px 0", color: T.textFaint, textAlign: "center", fontSize: T.fs.xs, letterSpacing: T.ls.label }}>
            NO DRIVER PINNED
          </div>
        )}
        {rows.map((r) => {
          const hasAll = r.s1 != null && r.s2 != null && r.s3 != null;
          const total = hasAll ? r.s1 + r.s2 + r.s3 : null;
          return (
            <div key={r.code} style={{ display: "grid", gridTemplateColumns: "36px 1fr 1fr 1fr 1fr", gap: 6, padding: "5px 0", borderBottom: "1px solid rgba(255,255,255,0.03)", alignItems: "center", fontVariantNumeric: "tabular-nums" }}>
              <div style={{ color: r.color, fontWeight: 700 }}>{r.code}</div>
              <div style={{ color: sectorColor(r.s1, r.pbS1, best?.s1_s) }}>{fmtSector(r.s1)}</div>
              <div style={{ color: sectorColor(r.s2, r.pbS2, best?.s2_s) }}>{fmtSector(r.s2)}</div>
              <div style={{ color: sectorColor(r.s3, r.pbS3, best?.s3_s) }}>{fmtSector(r.s3)}</div>
              <div style={{ color: T.text, fontWeight: 700 }}>{fmtSector(total)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

window.DriverCard = DriverCard;
window.CompareTraces = CompareTraces;
window.SectorTimes = SectorTimes;
