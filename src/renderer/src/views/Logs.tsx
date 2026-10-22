import { useEffect, useRef, useState } from "react";
import type { LogLine } from "../../../shared/api";

const api = window.parrotfish;

export function LogsView() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void api.logs().then(setLines);
    return api.on("log", (l) => setLines((all) => [...all.slice(-1999), l]));
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [lines.length]);
  return (
    <section className="log-pane mono small full">
      {lines.map((l, i) => (
        <div key={i}>
          <span className="muted">{new Date(l.at).toLocaleTimeString()}</span>{" "}
          <span className="scope">{l.scope}</span> {l.line}
        </div>
      ))}
      <div ref={end} />
    </section>
  );
}
