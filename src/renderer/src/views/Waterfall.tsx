import type { TurnTimings } from "../../../shared/types";
import { waterfallBars } from "../../../core/timing";
import { ms } from "../turns";

const LABELS: Record<string, string> = {
  endOfSpeech: "end of speech",
  sttFinal: "STT final",
  routerDecision: "router",
  toolCall: "tools",
  firstToken: "first token",
  firstSentence: "first sentence",
  firstAudio: "first audio",
  done: "done",
};

/** Per-turn waterfall: one bar per stage, from the previous mark to this one. */
export function Waterfall({ timings }: { timings: TurnTimings }) {
  const bars = waterfallBars(timings).filter((b) => b.mark !== "endOfSpeech");
  const hang = timings.vadHangMs ?? 0;
  const end = Math.max(1, ...bars.map((b) => b.to));
  const span = end + hang;
  const pct = (v: number): string => `${((v + hang) / span) * 100}%`;
  return (
    <div className="waterfall">
      <div className="wf-head">
        <span>voice to voice</span>
        <strong className="wf-v2v">{ms(timings.voiceToVoiceMs)}</strong>
        <span className="muted">total {ms(timings.totalMs)}</span>
      </div>
      {hang > 0 && (
        <div className="wf-row">
          <span className="wf-label">VAD hangover</span>
          <div className="wf-track">
            <div
              className="wf-bar wf-hang"
              style={{ left: 0, width: pct(0) }}
            />
          </div>
          <span className="wf-ms">{ms(hang)}</span>
        </div>
      )}
      {bars.map((b) => (
        <div
          className={`wf-row ${b.mark === "firstAudio" ? "wf-key" : ""}`}
          key={b.mark}
        >
          <span className="wf-label">{LABELS[b.mark] ?? b.mark}</span>
          <div className="wf-track">
            <div
              className={`wf-bar wf-${b.mark}`}
              style={{
                left: pct(b.from),
                width: `calc(${pct(b.to)} - ${pct(b.from)})`,
              }}
            />
          </div>
          <span className="wf-ms">
            {ms(b.to - b.from)} <span className="muted">@{ms(b.to)}</span>
          </span>
        </div>
      ))}
      {bars.length === 0 && <p className="muted">No marks yet.</p>}
    </div>
  );
}
