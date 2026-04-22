const LiveCtx = React.createContext(null);
function LiveProvider({ children }) {
  const [snapshot, setSnap] = React.useState(null);
  const [frame, setFrame]   = React.useState(null);
  const [rc, setRc]         = React.useState([]);
  const [playback, setPb]   = React.useState({ speed: 1, is_paused: false });
  const [loading, setLoading] = React.useState({ status: "loading", progress: 0 });

  React.useEffect(() => {
    const h = window.APEX_CLIENT.openSocket((msg) => {
      if (msg.type === "loading") {
        setLoading({ status: msg.status || "loading", progress: msg.progress || 0, message: msg.message });
      } else if (msg.type === "snapshot" || msg.type === "reset") {
        setLoading({ status: "ready", progress: 100 });
        setSnap(msg);
        window.__LIVE_SNAPSHOT = msg;
        setRc(msg.race_control_history || []);
        if (msg.playback) setPb(msg.playback);
        // Install snapshot data into APEX shim (colors, driver meta)
        if (window.APEX?._installSnapshot) window.APEX._installSnapshot(msg);
        // Also treat snapshot as first frame
        if (msg.standings?.length) {
          const snapFrame = {
            type: "frame",
            frame_index: msg.frame_index || 0,
            total_frames: msg.total_frames || 1,
            t: 0,
            t_seconds: 0,
            lap: msg.standings[0]?.lap || 1,
            total_laps: msg.total_laps || 1,
            clock: "00:00:00",
            track_status: "1",
            flag_state: msg.flag_state || "green",
            playback_speed: msg.playback?.speed || 1,
            is_paused: msg.playback?.is_paused ?? true,
            weather: {},
            safety_car: null,
            standings: msg.standings,
            new_rc_events: [],
          };
          window.__LIVE_FRAME = snapFrame;
          setFrame(snapFrame);
        }
      } else if (msg.type === "frame") {
        window.__LIVE_FRAME = msg;
        setFrame(msg);
        setPb((p) => ({ ...p, speed: msg.playback_speed, is_paused: msg.is_paused }));
        if (msg.new_rc_events?.length) {
          setRc((prev) => [...msg.new_rc_events.slice().reverse(), ...prev]);
        }
      }
    });
    return () => h.close();
  }, []);

  return <LiveCtx.Provider value={{ snapshot, frame, rc, playback, setPb, loading }}>{children}</LiveCtx.Provider>;
}
const useLive = () => React.useContext(LiveCtx);
window.LIVE = { LiveProvider, useLive };
