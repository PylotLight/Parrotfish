import { useEffect, useRef, useState } from 'react'
import type { Profile } from '../../../shared/profile'
import type { TurnRecord } from '../../../shared/types'
import { ms } from '../turns'
import { RouterPanel } from './RouterPanel'
import { Waterfall } from './Waterfall'

const api = window.parrotfish

export function LiveView({ turns, profile, onProfileSaved }: { turns: TurnRecord[]; profile: Profile | null; onProfileSaved: () => Promise<void> }) {
  const [selected, setSelected] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [threshold, setThreshold] = useState(profile?.router.threshold ?? 0.5)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const listEnd = useRef<HTMLDivElement>(null)

  useEffect(() => setThreshold(profile?.router.threshold ?? 0.5), [profile?.name, profile?.router.threshold])
  useEffect(() => listEnd.current?.scrollIntoView({ block: 'end' }), [turns.length])

  const turn = turns.find((t) => t.id === selected) ?? turns.at(-1) ?? null

  const onThreshold = (v: number): void => {
    setThreshold(v)
    if (!profile) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void api.profiles.save({ ...profile, router: { ...profile.router, threshold: v } }, profile.name).then(onProfileSaved)
    }, 300)
  }

  const send = (): void => {
    const t = text.trim()
    if (!t) return
    setText('')
    setSelected(null)
    void api.turns.text(t)
  }

  return (
    <div className="live">
      <section className="conversation">
        {turns.length === 0 && (
          <div className="empty">
            <p>Turn the mic on and talk, or type below.</p>
            <p className="muted small">
              Profile <strong>{profile?.name}</strong>: {profile?.description}
            </p>
          </div>
        )}
        {turns.map((t) => (
          <button key={t.id} className={`turn ${turn?.id === t.id ? 'selected' : ''} status-${t.status}`} onClick={() => setSelected(t.id)}>
            <div className="turn-user">
              <span className="who">{t.source === 'text' ? 'typed' : 'you'}</span> {t.transcript || <span className="muted">…</span>}
            </div>
            {(t.reply || t.status === 'running') && (
              <div className="turn-agent">
                <span className="who">agent</span> {t.reply || <span className="muted">thinking…</span>}
              </div>
            )}
            <div className="turn-meta">
              {t.decision && <span className={`chip route-${t.decision.action}`}>{t.decision.action}</span>}
              {t.tools.map((c, i) => (
                <span key={i} className="chip">
                  {c.name}
                  {c.approval !== 'not-needed' ? ` · ${c.approval}` : ''}
                </span>
              ))}
              <span className="muted">{t.profile}</span>
              <span className="v2v">{ms(t.timings.voiceToVoiceMs)}</span>
              {t.status !== 'done' && t.status !== 'running' && <span className={`chip ${t.status === 'error' ? 'danger' : ''}`}>{t.status}</span>}
            </div>
            {t.error && <div className="error small">{t.error}</div>}
          </button>
        ))}
        <div ref={listEnd} />
      </section>
      <aside className="inspector">
        {turn ? <Waterfall timings={turn.timings} /> : <div className="waterfall muted">No turns yet.</div>}
        <RouterPanel decision={turn?.decision ?? null} threshold={threshold} onThreshold={onThreshold} />
        {turn && turn.escalation.length > 0 && (
          <div className="panel">
            <div className="panel-title">Escalation</div>
            <ol className="small escalation">
              {turn.escalation.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ol>
          </div>
        )}
        {turn && turn.tools.length > 0 && (
          <div className="panel">
            <div className="panel-title">Tool calls</div>
            {turn.tools.map((c, i) => (
              <div key={i} className="tool-call small">
                <code>
                  {c.name}({JSON.stringify(c.args)})
                </code>
                <span className="muted"> {c.approval} · {ms(c.ms)}</span>
                <pre>{c.result}</pre>
              </div>
            ))}
          </div>
        )}
      </aside>
      <footer className="composer">
        <input
          value={text}
          placeholder="Type instead of talking (skips mic + STT)…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send()
          }}
        />
        <button className="primary" onClick={send} disabled={!text.trim()}>
          Send
        </button>
      </footer>
    </div>
  )
}
