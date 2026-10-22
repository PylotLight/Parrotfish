import { useEffect, useState } from "react";
import type { BenchReport, BenchRow } from "../../../core/bench";
import type { TimingSummary } from "../../../core/timing";
import { ms } from "../turns";

const api = window.parrotfish;

const METRICS: Array<[keyof BenchReport["summary"][number], string]> = [
  ["voiceToVoice", "voice to voice"],
  ["stt", "STT"],
  ["router", "router"],
  ["firstToken", "first token"],
  ["total", "total"],
];

export function BenchView({
  names,
  active,
}: {
  names: string[];
  active: string;
}) {
  const [wavs, setWavs] = useState<string[]>([]);
  const [texts, setTexts] = useState(
    "what time is it\ntell me a fun fact about octopuses\nopen safari",
  );
  const [a, setA] = useState(active);
  const [b, setB] = useState("");
  const [repeats, setRepeats] = useState(1);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [rows, setRows] = useState<BenchRow[]>([]);
  const [report, setReport] = useState<BenchReport | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  useEffect(() => {
    setA((x) => x || active);
  }, [active]);
  useEffect(
    () =>
      api.on("bench:row", ({ row, done, total }) => {
        setRows((r) => [...r, row]);
        setProgress({ done, total });
      }),
    [],
  );

  const run = async (): Promise<void> => {
    setRunning(true);
    setRows([]);
    setReport(null);
    setError("");
    setSaved("");
    try {
      const profiles = [a, b].filter((x, i, all) => x && all.indexOf(x) === i);
      setReport(
        await api.bench.run({
          wavPaths: wavs,
          texts: texts.split("\n"),
          profiles,
          repeats,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const cell = (s: TimingSummary): string =>
    s.n ? `${ms(s.median)} / ${ms(s.p90)}` : "–";
  const summary = report?.summary ?? [];

  return (
    <div className="bench">
      <section className="panel bench-setup">
        <div className="panel-title">Cases</div>
        <div className="row">
          <button
            onClick={() =>
              void api.bench
                .pickWavs()
                .then((p) => setWavs((w) => [...new Set([...w, ...p])]))
            }
          >
            Add WAVs…
          </button>
          {wavs.length > 0 && (
            <button className="ghost" onClick={() => setWavs([])}>
              Clear
            </button>
          )}
          <span className="muted small">
            a .txt next to a WAV is its transcript (the Mock STT returns it)
          </span>
        </div>
        <ul className="small wav-list">
          {wavs.map((w) => (
            <li key={w}>{w.split("/").pop()}</li>
          ))}
        </ul>
        <label className="field">
          <span>Text cases (one per line, skip mic + STT)</span>
          <textarea
            rows={4}
            value={texts}
            onChange={(e) => setTexts(e.target.value)}
          />
        </label>
        <div className="row">
          <label className="field inline">
            <span>Profile A</span>
            <select value={a} onChange={(e) => setA(e.target.value)}>
              {names.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <label className="field inline">
            <span>Profile B</span>
            <select value={b} onChange={(e) => setB(e.target.value)}>
              <option value="">(none)</option>
              {names.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <label className="field inline">
            <span>Repeats</span>
            <input
              type="number"
              min={1}
              max={20}
              value={repeats}
              onChange={(e) => setRepeats(Number(e.target.value) || 1)}
            />
          </label>
          {running ? (
            <button onClick={() => void api.bench.cancel()}>Cancel</button>
          ) : (
            <button
              className="primary"
              onClick={() => void run()}
              disabled={!a}
            >
              Run bench
            </button>
          )}
          {progress && running && (
            <span className="muted">
              {progress.done}/{progress.total}
            </span>
          )}
        </div>
        <p className="muted small">
          Bench turns are isolated (no history), destructive tools are
          auto-denied, and first audio is when the first chunk is synthesized
          (nothing plays).
        </p>
        {error && <div className="error">{error}</div>}
      </section>

      {summary.length > 0 && (
        <section className="panel">
          <div className="panel-title">
            Median / p90
            <button
              className="ghost right"
              onClick={() =>
                void api.bench
                  .exportJson(report!)
                  .then((p) => setSaved(p ?? ""))
              }
            >
              Export JSON
            </button>
          </div>
          {saved && <p className="muted small">Saved {saved}</p>}
          <table className="table">
            <thead>
              <tr>
                <th>metric</th>
                {summary.map((s) => (
                  <th key={s.profile}>{s.profile}</th>
                ))}
                {summary.length === 2 && <th>B − A (median)</th>}
              </tr>
            </thead>
            <tbody>
              {METRICS.map(([key, label]) => {
                const values = summary.map((s) => s[key] as TimingSummary);
                const delta =
                  values.length === 2 &&
                  values[0]!.median !== null &&
                  values[1]!.median !== null
                    ? values[1]!.median! - values[0]!.median!
                    : null;
                return (
                  <tr key={key}>
                    <td>{label}</td>
                    {values.map((v, i) => (
                      <td key={i}>{cell(v)}</td>
                    ))}
                    {summary.length === 2 && (
                      <td
                        className={
                          delta === null ? "" : delta < 0 ? "good" : "bad"
                        }
                      >
                        {delta === null
                          ? "–"
                          : `${delta > 0 ? "+" : ""}${ms(delta)}`}
                      </td>
                    )}
                  </tr>
                );
              })}
              <tr>
                <td>errors</td>
                {summary.map((s) => (
                  <td key={s.profile}>{s.errors}</td>
                ))}
                {summary.length === 2 && <td />}
              </tr>
            </tbody>
          </table>
        </section>
      )}

      {rows.length > 0 && (
        <section className="panel">
          <div className="panel-title">Runs</div>
          <table className="table small">
            <thead>
              <tr>
                <th>case</th>
                <th>profile</th>
                <th>transcript</th>
                <th>route</th>
                <th>STT</th>
                <th>first token</th>
                <th>v2v</th>
                <th>total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={i}
                  className={r.status === "error" ? "row-error" : ""}
                  title={r.error ?? r.reply}
                >
                  <td>{r.case}</td>
                  <td>{r.profile}</td>
                  <td className="clip">{r.transcript}</td>
                  <td>{r.route}</td>
                  <td>{ms(r.sttMs)}</td>
                  <td>{ms(r.firstTokenMs)}</td>
                  <td>{ms(r.voiceToVoiceMs)}</td>
                  <td>{r.status === "error" ? "error" : ms(r.totalMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
