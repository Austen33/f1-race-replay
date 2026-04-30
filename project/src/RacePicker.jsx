// Pre-pit-wall screen. Lets the user pick a season → round → session type
// and POSTs /api/session/load. Once loading begins, control hands off to
// loading_gate.jsx which already owns the loading overlay + transition.

const TH = window.THEME;
const APEX = window.APEX_CLIENT;

const SESSION_TYPES = [
  { id: "R",  label: "RACE",         long: "LOAD RACE" },
  { id: "Q",  label: "QUALI",        long: "LOAD QUALI" },
  { id: "SQ", label: "SPRINT QUALI", long: "LOAD SPRINT QUALI" },
];
const SESSION_LABEL = Object.fromEntries(SESSION_TYPES.map((s) => [s.id, s.long]));

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function parseEventDate(s) {
  if (!s) return null;
  const d = new Date(typeof s === "string" && s.length === 10 ? s + "T00:00:00" : s);
  return isNaN(d.getTime()) ? null : d;
}

function daysBetween(a, b) {
  const ms = b.getTime() - a.getTime();
  return Math.round(ms / 86400000);
}

function classifyRound(round, today) {
  // Pick the most-relevant per-session date if available, else event date.
  const sd = round.session_dates || {};
  const candidates = ["Race", "Sprint", "Qualifying", "Sprint Qualifying"]
    .map((k) => sd[k]).filter(Boolean);
  const headlineISO = candidates[0] || round.date;
  const eventDate = parseEventDate(headlineISO) || parseEventDate(round.date);
  if (!eventDate) return { state: "unknown", days: null };
  const days = daysBetween(today, eventDate);
  if (days < -1) return { state: "past", days };
  if (days <= 0) return { state: "live", days };
  return { state: "future", days };
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function RacePickerHeader({ sessionType, onOpenSearch }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 14,
      padding: "20px 28px",
      borderBottom: "1px solid rgba(255,255,255,0.06)",
      background: "linear-gradient(180deg, rgba(20,20,30,0.6), rgba(11,11,17,0.2))",
    }}>
      <div style={{
        width: 10, height: 28, background: TH.hot,
        boxShadow: `0 0 12px ${TH.hot}`,
      }}/>
      <div style={{
        fontFamily: TH.mono, fontSize: TH.fs.lg, fontWeight: 800,
        color: TH.textStrong, letterSpacing: TH.ls.wide,
      }}>
        APEX · PITWALL
      </div>
      <div style={{ flex: 1 }}/>
      <div style={{
        fontFamily: TH.mono, fontSize: TH.fs.xs, color: TH.textMuted,
        letterSpacing: TH.ls.caps,
        display: "flex", alignItems: "center", gap: 6,
      }}>
        VIEWING:&nbsp;
        <span style={{ color: TH.hot, fontWeight: 800 }}>
          {SESSION_TYPES.find((s) => s.id === sessionType)?.label || "RACE"} SESSION
        </span>
      </div>
      <button onClick={onOpenSearch} style={{
        padding: "6px 10px",
        background: "transparent",
        border: "1px solid rgba(255,255,255,0.12)",
        color: TH.textMuted,
        fontFamily: TH.mono, fontSize: TH.fs.xs, fontWeight: 700,
        letterSpacing: TH.ls.caps, cursor: "pointer",
        display: "flex", alignItems: "center", gap: 8,
      }} title="Search races (⌘K or /)">
        <span>⌕  SEARCH</span>
        <span style={{
          padding: "1px 5px",
          border: "1px solid rgba(255,255,255,0.15)",
          color: TH.textFaint, fontSize: TH.fs.xs,
        }}>⌘K</span>
      </button>
    </div>
  );
}

function YearSelector({ years, selected, onChange, roundCounts }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {years.map((y) => {
        const active = y === selected;
        const count = roundCounts[y];
        return (
          <button key={y} onClick={() => onChange(y)} style={{
            padding: "6px 12px 4px",
            background: active ? TH.hot : "transparent",
            color: active ? "#0B0B11" : TH.text,
            border: active ? `1px solid ${TH.hot}` : "1px solid rgba(255,255,255,0.1)",
            cursor: "pointer",
            fontFamily: TH.mono, fontSize: TH.fs.sm,
            fontWeight: 700, letterSpacing: TH.ls.caps,
            transition: "all 120ms ease",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
            minWidth: 56,
          }}>
            <div>{y}</div>
            <div style={{
              fontSize: 8, fontWeight: 600,
              color: active ? "rgba(11,11,17,0.7)" : TH.textFaint,
              letterSpacing: TH.ls.caps,
            }}>
              {count != null ? `${count} RDS` : "—"}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function SessionTypeToggle({ value, onChange, dense = false }) {
  return (
    <div style={{ display: "inline-flex", border: "1px solid rgba(255,255,255,0.1)" }}>
      {SESSION_TYPES.map((st) => {
        const active = st.id === value;
        return (
          <button key={st.id} onClick={(e) => { e.stopPropagation(); onChange(st.id); }} style={{
            padding: dense ? "3px 8px" : "6px 12px",
            background: active ? "rgba(255,30,0,0.18)" : "transparent",
            color: active ? TH.textStrong : TH.textMuted,
            border: "none",
            borderLeft: st.id !== "R" ? "1px solid rgba(255,255,255,0.08)" : "none",
            cursor: "pointer",
            fontFamily: TH.mono, fontSize: TH.fs.xs,
            fontWeight: 700, letterSpacing: TH.ls.caps,
            transition: "all 120ms ease",
          }}>
            {st.label}
          </button>
        );
      })}
    </div>
  );
}

function CacheBadge({ state }) {
  if (state === "unknown") return null;
  const isCached = state === "cached";
  const color = isCached ? TH.good : TH.caution;
  const label = isCached ? "CACHED" : "NO CACHE";
  return (
    <div style={{
      display: "inline-flex", alignItems: "center",
      padding: "2px 6px 2px 8px",
      borderLeft: `2px solid ${color}`,
      background: "rgba(0,0,0,0.25)",
      color, fontFamily: TH.mono, fontSize: TH.fs.xs,
      fontWeight: 700, letterSpacing: TH.ls.caps,
    }}>
      {label}
    </div>
  );
}

function StatusBadge({ classification, isNext }) {
  if (isNext) {
    return (
      <div style={{
        padding: "2px 6px",
        background: TH.hot,
        color: "#0B0B11",
        fontFamily: TH.mono, fontSize: TH.fs.xs,
        fontWeight: 800, letterSpacing: TH.ls.caps,
      }}>
        NEXT RACE
      </div>
    );
  }
  if (classification.state === "live") {
    return (
      <div style={{
        padding: "2px 6px",
        background: "rgba(30,255,106,0.15)",
        color: TH.good, border: `1px solid ${TH.good}`,
        fontFamily: TH.mono, fontSize: TH.fs.xs,
        fontWeight: 800, letterSpacing: TH.ls.caps,
      }}>
        LIVE
      </div>
    );
  }
  if (classification.state === "past") {
    return (
      <div style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        padding: "2px 6px",
        background: "rgba(30,255,106,0.08)",
        color: TH.good,
        fontFamily: TH.mono, fontSize: TH.fs.xs,
        fontWeight: 700, letterSpacing: TH.ls.caps,
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: "50%",
          background: TH.good, boxShadow: `0 0 5px ${TH.good}`,
        }}/>
        DATA AVAILABLE
      </div>
    );
  }
  if (classification.state === "future") {
    const days = classification.days;
    return (
      <div style={{
        padding: "2px 6px",
        border: "1px dashed rgba(255,184,0,0.4)",
        color: TH.caution,
        fontFamily: TH.mono, fontSize: TH.fs.xs,
        fontWeight: 700, letterSpacing: TH.ls.caps,
      }}>
        SCHEDULED · {days != null ? `IN ${days}D` : "TBC"}
      </div>
    );
  }
  return null;
}

function RoundCard({
  round, year, sessionType, onPick, onChangeSessionType,
  isSelected, isLoading, isDisabled, isFuture, isNext,
  cacheState, classification,
}) {
  const [hover, setHover] = React.useState(false);

  const accentColor = isNext
    ? TH.hot
    : (isSelected ? TH.hot : (hover ? "rgba(255,30,0,0.7)" : "transparent"));
  const accentWidth = (isSelected || isNext || hover) ? 4 : 4;
  const isPast = classification.state === "past" || classification.state === "live";
  const interactive = !isDisabled;

  const bgHover = hover && interactive
    ? "linear-gradient(180deg, rgba(36,28,40,0.92) 0%, rgba(20,16,24,0.95) 100%)"
    : TH.surface2;

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => interactive && onPick(round)}
      role="button"
      tabIndex={interactive ? 0 : -1}
      onKeyDown={(e) => {
        if (!interactive) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(round); }
      }}
      style={{
        position: "relative",
        textAlign: "left",
        padding: "14px 16px 12px 14px",
        background: bgHover,
        border: "1px solid rgba(255,255,255,0.08)",
        borderLeft: `${accentWidth}px solid ${accentColor}`,
        cursor: interactive ? "pointer" : "not-allowed",
        opacity: isFuture ? 0.55 : (isDisabled && !isLoading ? 0.5 : 1),
        fontFamily: TH.mono,
        color: TH.text,
        animation: "apex-panel-in 120ms ease both",
        transition: "border-color 120ms ease, background 120ms ease, transform 120ms ease, box-shadow 120ms ease",
        transform: hover && interactive ? "translateY(-1px)" : "none",
        boxShadow: hover && interactive
          ? "0 6px 20px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,30,0,0.15)"
          : "none",
        display: "flex", flexDirection: "column", gap: 6,
        minHeight: 138,
        outline: "none",
      }}
    >
      {(isSelected || isLoading) && (
        <div style={{
          position: "absolute", inset: 0,
          background: "rgba(11,11,17,0.55)",
          pointerEvents: "none",
        }}/>
      )}

      {/* Top row: round + status */}
      <div style={{
        display: "flex", justifyContent: "space-between",
        alignItems: "flex-start", gap: 8,
      }}>
        <div style={{
          fontSize: TH.fs.xs, color: TH.textMuted,
          letterSpacing: TH.ls.caps,
        }}>
          ROUND {String(round.round_number).padStart(2, "0")} · {year}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <StatusBadge classification={classification} isNext={isNext}/>
          {isPast && <CacheBadge state={cacheState}/>}
        </div>
      </div>

      {/* Title */}
      <div style={{
        fontSize: TH.fs.lg, fontWeight: 800, color: TH.textStrong,
        letterSpacing: TH.ls.tight, lineHeight: 1.15,
      }}>
        {(round.event_name || "").toUpperCase()}
      </div>
      <div style={{
        fontSize: TH.fs.sm, color: TH.textMuted,
        letterSpacing: TH.ls.body,
      }}>
        {(round.country || "").toUpperCase()}
        {round.date ? ` · ${round.date}` : ""}
      </div>

      <div style={{ flex: 1 }}/>

      {/* Bottom row: per-card session toggle + load CTA */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        gap: 8, position: "relative", zIndex: 2,
      }}>
        <SessionTypeToggle value={sessionType} onChange={onChangeSessionType} dense/>
        <div style={{
          fontSize: TH.fs.xs, fontWeight: 700,
          color: isLoading ? TH.hot
            : isFuture ? TH.caution
            : (hover ? TH.hot : TH.textFaint),
          letterSpacing: TH.ls.caps,
          display: "flex", alignItems: "center", gap: 6,
          transition: "color 120ms ease",
        }}>
          {isLoading ? (
            <>
              <span style={{
                display: "inline-block", width: 9, height: 9,
                border: `2px solid ${TH.hot}`, borderRightColor: "transparent",
                borderRadius: "50%",
                animation: "apex-spin 0.7s linear infinite",
              }}/>
              STARTING…
            </>
          ) : isFuture
            ? "SCHEDULED · NO DATA"
            : `${SESSION_LABEL[sessionType] || "LOAD"} →`}
        </div>
      </div>
    </div>
  );
}

function StatusLine({ children, tone = "muted" }) {
  const color = tone === "error" ? TH.hot : TH.textMuted;
  return (
    <div style={{
      fontFamily: TH.mono, fontSize: TH.fs.sm,
      color, letterSpacing: TH.ls.body, padding: "20px 0",
    }}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Command palette
// ---------------------------------------------------------------------------

function CommandPalette({ rounds, year, onClose, onPick }) {
  const [q, setQ] = React.useState("");
  const [idx, setIdx] = React.useState(0);
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
  }, []);

  const matches = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rounds.slice(0, 12);
    return rounds.filter((r) => {
      const hay = `${r.event_name || ""} ${r.country || ""} round ${r.round_number}`.toLowerCase();
      return hay.includes(needle);
    }).slice(0, 12);
  }, [q, rounds]);

  React.useEffect(() => { setIdx(0); }, [q]);

  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(matches.length - 1, i + 1)); return; }
    if (e.key === "ArrowUp")   { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      const r = matches[idx];
      if (r) onPick(r);
    }
  };

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
      zIndex: 2000, display: "flex", alignItems: "flex-start", justifyContent: "center",
      paddingTop: "10vh",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "min(560px, 92vw)",
        background: TH.surface3,
        border: "1px solid rgba(255,30,0,0.4)",
        boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
        fontFamily: TH.mono, color: TH.text,
      }}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder={`Search ${year} races — try "italy" or "round 5"`}
          style={{
            width: "100%", padding: "14px 16px",
            background: "transparent", border: "none",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
            color: TH.textStrong, fontFamily: TH.mono,
            fontSize: TH.fs.md, outline: "none",
            letterSpacing: TH.ls.body,
          }}
        />
        <div style={{ maxHeight: "50vh", overflow: "auto" }}>
          {matches.length === 0 && (
            <div style={{ padding: 16, color: TH.textFaint, fontSize: TH.fs.sm }}>
              NO MATCHES.
            </div>
          )}
          {matches.map((r, i) => {
            const active = i === idx;
            return (
              <div key={r.round_number} onClick={() => onPick(r)} onMouseEnter={() => setIdx(i)} style={{
                padding: "10px 16px",
                background: active ? "rgba(255,30,0,0.12)" : "transparent",
                borderLeft: active ? `3px solid ${TH.hot}` : "3px solid transparent",
                cursor: "pointer",
                display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12,
              }}>
                <div>
                  <div style={{ fontSize: TH.fs.sm, color: TH.textStrong, fontWeight: 700 }}>
                    {(r.event_name || "").toUpperCase()}
                  </div>
                  <div style={{ fontSize: TH.fs.xs, color: TH.textMuted, letterSpacing: TH.ls.body }}>
                    R{String(r.round_number).padStart(2, "0")} · {(r.country || "").toUpperCase()} · {r.date}
                  </div>
                </div>
                {active && (
                  <div style={{
                    fontSize: TH.fs.xs, color: TH.hot, fontWeight: 700,
                    letterSpacing: TH.ls.caps,
                  }}>
                    ↵ LOAD
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div style={{
          padding: "8px 16px",
          borderTop: "1px solid rgba(255,255,255,0.06)",
          fontSize: TH.fs.xs, color: TH.textFaint,
          letterSpacing: TH.ls.caps,
          display: "flex", gap: 14,
        }}>
          <span>↑↓ NAVIGATE</span>
          <span>↵ LOAD</span>
          <span>ESC CLOSE</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function RacePicker({ onLoadStarted }) {
  const [seasonsState, setSeasonsState] = React.useState({ loading: true, error: null, years: [] });
  const [year, setYear] = React.useState(null);
  const [sessionType, setSessionType] = React.useState("R");
  const [roundsState, setRoundsState] = React.useState({ loading: false, error: null, rounds: [] });
  const [roundCounts, setRoundCounts] = React.useState({});
  const [cacheSet, setCacheSet] = React.useState(() => new Set());
  const [selecting, setSelecting] = React.useState(null);
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  // Today (used to classify past/future). Refreshes once per minute so the
  // "live" window stays correct across long-running tabs.
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Seasons
  React.useEffect(() => {
    let alive = true;
    APEX.get("/api/seasons").then((res) => {
      if (!alive) return;
      const ys = (res?.seasons || []).slice().sort((a, b) => b - a);
      setSeasonsState({ loading: false, error: null, years: ys });
      if (ys.length) setYear(ys[0]);
    }).catch((e) => {
      if (!alive) return;
      setSeasonsState({ loading: false, error: String(e?.message || e), years: [] });
    });
    return () => { alive = false; };
  }, []);

  // Cache index — single fetch, reused for all year/session combos
  React.useEffect(() => {
    let alive = true;
    APEX.get("/api/web_cache/index").then((res) => {
      if (!alive) return;
      const set = new Set();
      for (const e of (res?.entries || [])) {
        set.add(`${e.year}_${e.round}_${e.session_type}`);
      }
      setCacheSet(set);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Rounds for selected year
  React.useEffect(() => {
    if (year == null) return;
    let alive = true;
    setRoundsState({ loading: true, error: null, rounds: [] });
    APEX.get(`/api/seasons/${year}/rounds`).then((res) => {
      if (!alive) return;
      if (res && res.error) {
        setRoundsState({ loading: false, error: String(res.error), rounds: [] });
        return;
      }
      const rounds = Array.isArray(res) ? res : (res?.rounds || []);
      setRoundsState({ loading: false, error: null, rounds });
      setRoundCounts((prev) => ({ ...prev, [year]: rounds.length }));
    }).catch((e) => {
      if (!alive) return;
      setRoundsState({ loading: false, error: String(e?.message || e), rounds: [] });
    });
    return () => { alive = false; };
  }, [year]);

  // Classify rounds + find next race
  const { classifiedRounds, nextRoundNumber } = React.useMemo(() => {
    const list = roundsState.rounds.map((r) => ({
      round: r,
      classification: classifyRound(r, now),
    }));
    let nextRoundNum = null;
    let nextDays = Infinity;
    for (const item of list) {
      if (item.classification.state === "future" && item.classification.days != null && item.classification.days < nextDays) {
        nextDays = item.classification.days;
        nextRoundNum = item.round.round_number;
      }
    }
    if (nextRoundNum == null) {
      const live = list.find((it) => it.classification.state === "live");
      if (live) nextRoundNum = live.round.round_number;
    }
    return { classifiedRounds: list, nextRoundNumber: nextRoundNum };
  }, [roundsState.rounds, now]);

  // Picking a race
  const handlePick = async (round) => {
    if (selecting != null) return;
    const cls = classifyRound(round, now);
    if (cls.state === "future") return; // hard-block — no data yet
    setSelecting(round.round_number);
    try {
      await APEX.post("/api/session/load", {
        year, round: round.round_number, session_type: sessionType,
      });
      if (onLoadStarted) onLoadStarted({ year, round: round.round_number, session_type: sessionType });
    } catch (e) {
      setSelecting(null);
      setRoundsState((s) => ({ ...s, error: `Load failed: ${e?.message || e}` }));
    }
  };

  // Global hotkeys: ⌘K / Ctrl+K / "/"
  React.useEffect(() => {
    const onKey = (e) => {
      if (paletteOpen) return;
      const isCmdK = (e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K");
      const isSlash = e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey
        && !(document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName));
      if (isCmdK || isSlash) {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen]);

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: "radial-gradient(ellipse at 50% 30%, rgba(40,12,12,0.6) 0%, rgba(11,11,17,1) 55%, #05050A 100%)",
      color: TH.text, fontFamily: TH.mono,
      display: "flex", flexDirection: "column",
      overflow: "hidden",
    }} className="scanline">
      <RacePickerHeader
        sessionType={sessionType}
        onOpenSearch={() => setPaletteOpen(true)}
      />

      <div style={{
        padding: "22px 28px 14px",
        display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
      }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{
            fontSize: TH.fs.xs, color: TH.textFaint, letterSpacing: TH.ls.wide,
          }}>SEASON</div>
          {seasonsState.loading
            ? <div style={{ color: TH.textMuted, fontSize: TH.fs.sm }}>LOADING SEASONS…</div>
            : seasonsState.error
              ? <div style={{ color: TH.hot, fontSize: TH.fs.sm }}>FAILED · {seasonsState.error}</div>
              : <YearSelector years={seasonsState.years} selected={year} onChange={setYear} roundCounts={roundCounts}/>
          }
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{
            fontSize: TH.fs.xs, color: TH.textFaint, letterSpacing: TH.ls.wide,
          }}>SESSION (DEFAULT FOR EACH RACE)</div>
          <SessionTypeToggle value={sessionType} onChange={setSessionType}/>
        </div>

        <div style={{ flex: 1 }}/>

        <div style={{
          fontSize: TH.fs.xs, color: TH.textFaint, letterSpacing: TH.ls.caps,
          alignSelf: "flex-end", paddingBottom: 4,
        }}>
          PRESS&nbsp;
          <span style={{ color: TH.textMuted, padding: "1px 5px", border: "1px solid rgba(255,255,255,0.15)" }}>/</span>
          &nbsp;TO SEARCH
        </div>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "20px 28px 32px" }}>
        {roundsState.loading && <StatusLine>LOADING ROUNDS FOR {year}…</StatusLine>}
        {roundsState.error && <StatusLine tone="error">{roundsState.error}</StatusLine>}
        {!roundsState.loading && !roundsState.error && classifiedRounds.length === 0 && year != null && (
          <StatusLine>NO ROUNDS AVAILABLE FOR {year}.</StatusLine>
        )}

        {!roundsState.loading && classifiedRounds.length > 0 && (
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
            gap: 12,
          }}>
            {classifiedRounds.map(({ round, classification }) => {
              const key = `${year}_${round.round_number}_${sessionType}`;
              const cacheState = cacheSet.has(key) ? "cached" : "missing";
              const isFuture = classification.state === "future";
              return (
                <RoundCard
                  key={round.round_number}
                  round={round}
                  year={year}
                  sessionType={sessionType}
                  onPick={handlePick}
                  onChangeSessionType={setSessionType}
                  isSelected={selecting === round.round_number}
                  isLoading={selecting === round.round_number}
                  isDisabled={selecting != null && selecting !== round.round_number || isFuture}
                  isFuture={isFuture}
                  isNext={nextRoundNumber === round.round_number}
                  cacheState={cacheState}
                  classification={classification}
                />
              );
            })}
          </div>
        )}
      </div>

      {paletteOpen && (
        <CommandPalette
          rounds={roundsState.rounds}
          year={year}
          onClose={() => setPaletteOpen(false)}
          onPick={(r) => {
            setPaletteOpen(false);
            handlePick(r);
          }}
        />
      )}

      {/* Inline keyframes — adds spinner without touching theme.js */}
      <style>{`
        @keyframes apex-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

window.RacePicker = RacePicker;
