import { useCallback, useEffect, useRef, useState } from "react";
import type { MicStatus } from "../../shared/api";
import type { Profile } from "../../shared/profile";
import type {
  ApprovalRequest,
  LiveState,
  TurnRecord,
} from "../../shared/types";
import { openMic, type MicHandle } from "./audio/mic";
import { Player } from "./audio/player";
import { applyEvent } from "./turns";
import { BenchView } from "./views/Bench";
import { LiveView } from "./views/Live";
import { LocalModels } from "./views/LocalModels";
import { Logo } from "./views/Logo";
import { LogsView } from "./views/Logs";
import { ProfilesView } from "./views/Profiles";
import { SidecarsView } from "./views/Sidecars";

const api = window.parrotfish;
type Tab = "live" | "bench" | "profiles" | "sidecars" | "logs";
const TABS: Array<[Tab, string]> = [
  ["live", "Live"],
  ["bench", "Bench"],
  ["profiles", "Profiles"],
  ["sidecars", "Sidecars"],
  ["logs", "Logs"],
];

export default function App() {
  const [tab, setTab] = useState<Tab>("live");
  const [names, setNames] = useState<string[]>([]);
  const [active, setActive] = useState("");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  const [state, setState] = useState<LiveState>("idle");
  const [micStarting, setMicStarting] = useState(false);
  const [mic, setMic] = useState<MicStatus>({ on: false, vad: "" });
  const [level, setLevel] = useState({ p: 0, speaking: false });
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const player = useRef<Player | null>(null);
  const micHandle = useRef<MicHandle | null>(null);

  const refreshProfiles = useCallback(async () => {
    const list = await api.profiles.list();
    setNames(list.names);
    setActive(list.active);
    setProfile(await api.profiles.get(list.active));
  }, []);

  useEffect(() => {
    player.current = new Player();
    void refreshProfiles();
    void api.turns.history().then((h) => setTurns([...h].reverse()));
    const offs = [
      api.on("turn:event", (e) => setTurns((t) => applyEvent(t, e))),
      api.on("state", setState),
      api.on("level", setLevel),
      api.on("mic", setMic),
      api.on("approval:request", setApproval),
      api.on("audio:begin", (id) => player.current?.begin(id)),
      api.on("audio:chunk", (c) =>
        player.current?.chunk(c.turnId, c.samples, c.sampleRate),
      ),
      api.on("audio:end", (id) => player.current?.end(id)),
      api.on("audio:stop", () => player.current?.stop()),
      api.on("profiles:changed", () => void refreshProfiles()),
    ];
    return () => {
      for (const off of offs) off();
      micHandle.current?.stop();
    };
  }, [refreshProfiles]);

  const toggleMic = async (): Promise<void> => {
    if (mic.on) {
      micHandle.current?.stop();
      micHandle.current = null;
      setMic(await api.mic.stop());
      return;
    }
    setMicStarting(true);
    try {
      const status = await api.mic.start();
      setMic(status);
      if (!status.on) return;
      micHandle.current = await openMic((frame) => api.mic.frames(frame));
    } catch (error) {
      await api.mic.stop();
      setMic({
        on: false,
        vad: "",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setMicStarting(false);
    }
  };

  const switchProfile = async (name: string): Promise<void> => {
    await api.profiles.setActive(name);
    await refreshProfiles();
  };

  const answer = (ok: boolean): void => {
    if (approval) void api.turns.answerApproval(approval.id, ok);
    setApproval(null);
  };

  return (
    <div className={`app platform-${api.platform}`}>
      <header className="titlebar">
        <Logo />
        <nav className="tabs">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              className={tab === id ? "tab active" : "tab"}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="titlebar-right">
          <select
            className="profile-switch"
            value={active}
            onChange={(e) => void switchProfile(e.target.value)}
            title="Active profile"
          >
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className={`state-pill state-${state}`}>{state}</span>
          <button
            className={mic.on ? "mic on" : "mic"}
            onClick={() => void toggleMic()}
            disabled={micStarting}
            title={mic.on ? `Listening (${mic.vad} VAD)` : "Start listening"}
          >
            <span
              className="mic-dot"
              style={{
                transform: `scale(${1 + (mic.on ? level.p : 0) * 0.8})`,
              }}
            />
            {micStarting
              ? "preparing mic…"
              : mic.on
                ? level.speaking
                  ? "hearing you"
                  : "listening"
                : "mic off"}
          </button>
          <button
            className="ghost"
            onClick={() => void api.turns.cancel()}
            disabled={state === "idle"}
            title="Stop the agent (same as barge-in)"
          >
            Stop
          </button>
        </div>
      </header>
      {mic.error && <div className="banner warn">{mic.error}</div>}
      <main className="content">
        {tab === "live" && (
          <>
            {profile?.stt.provider === "parakeet-local" && (
              <LocalModels
                key={profile.name}
                profile={profile}
                onProfileSaved={refreshProfiles}
                disabled={mic.on || micStarting || state !== "idle"}
              />
            )}
            <LiveView
              turns={turns}
              profile={profile}
              onProfileSaved={refreshProfiles}
            />
          </>
        )}
        {tab === "bench" && <BenchView names={names} active={active} />}
        {tab === "profiles" && (
          <ProfilesView
            names={names}
            active={active}
            onChanged={refreshProfiles}
          />
        )}
        {tab === "sidecars" && <SidecarsView />}
        {tab === "logs" && <LogsView />}
      </main>
      {approval && (
        <div className="modal-backdrop">
          <div className="modal">
            <h3>Allow this action?</h3>
            <p>{approval.summary}</p>
            <pre className="small">
              {JSON.stringify(approval.args, null, 2)}
            </pre>
            <div className="row end">
              <button className="ghost" onClick={() => answer(false)}>
                Deny
              </button>
              <button
                className="primary"
                onClick={() => answer(true)}
                autoFocus
              >
                Allow
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
