import { useEffect, useRef, useState } from 'react'
import type { SidecarState } from '../../../shared/api'

const api = window.parrotfish

export function SidecarsView() {
  const [items, setItems] = useState<SidecarState[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void api.sidecars.list().then((l) => {
      setItems(l)
      setSelected((s) => s ?? l[0]?.id ?? null)
    })
    const offState = api.on('sidecar', (s) => setItems((all) => (all.some((x) => x.id === s.id) ? all.map((x) => (x.id === s.id ? s : x)) : [...all, s])))
    const offProfiles = api.on('profiles:changed', () => void api.sidecars.list().then(setItems))
    return () => {
      offState()
      offProfiles()
    }
  }, [])
  useEffect(() => {
    if (!selected) return
    void api.sidecars.logs(selected).then(setLines)
    return api.on('sidecar:log', ({ id, line }) => {
      if (id === selected) setLines((l) => [...l.slice(-799), line])
    })
  }, [selected])
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [lines.length])

  return (
    <div className="sidecars">
      <section className="sidecar-list">
        {items.length === 0 && <p className="muted">This profile has no sidecars. Add them in Profiles.</p>}
        {items.map((s) => (
          <div key={s.id} className={`sidecar ${s.id === selected ? 'selected' : ''}`} onClick={() => setSelected(s.id)}>
            <div className="row">
              <span className={`dot status-${s.status}`} />
              <strong>{s.label}</strong>
              <span className="muted small">{s.status}</span>
              <span className="spacer" />
              {s.status === 'stopped' || s.status === 'exited' ? (
                <button onClick={(e) => (e.stopPropagation(), void api.sidecars.start(s.id))}>Start</button>
              ) : (
                <button onClick={(e) => (e.stopPropagation(), void api.sidecars.stop(s.id))}>Stop</button>
              )}
            </div>
            <code className="small">{s.command}</code>
            <div className="muted small">
              {s.healthUrl ? `${s.healthUrl} · ${s.detail}` : s.detail}
              {s.exitCode !== undefined && s.exitCode !== null ? ` · exit ${s.exitCode}` : ''}
            </div>
          </div>
        ))}
      </section>
      <section className="log-pane mono small">
        {lines.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
        <div ref={end} />
      </section>
    </div>
  )
}
