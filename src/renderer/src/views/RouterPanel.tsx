import { ROUTER_CHOICES, type RouterDecision } from '../../../shared/types'

/** Router probabilities with the threshold line; the slider edits the active profile live. */
export function RouterPanel({ decision, threshold, onThreshold }: { decision: RouterDecision | null; threshold: number; onThreshold: (v: number) => void }) {
  return (
    <div className="router-panel">
      <div className="panel-title">
        Router {decision && <span className="muted">· {decision.provider}</span>}
        {decision?.belowThreshold && <span className="chip warn">below threshold: {decision.choice} → {decision.action}</span>}
      </div>
      {ROUTER_CHOICES.map((c) => {
        const p = decision?.probabilities[c] ?? 0
        const picked = decision?.action === c
        return (
          <div className={`prob-row ${picked ? 'picked' : ''}`} key={c}>
            <span className="prob-label">{c}</span>
            <div className="prob-track">
              <div className="prob-bar" style={{ width: `${Math.round(p * 100)}%` }} />
              <div className="prob-threshold" style={{ left: `${threshold * 100}%` }} />
            </div>
            <span className="prob-val">{decision ? p.toFixed(2) : '–'}</span>
          </div>
        )
      })}
      {decision && (decision.endOfTurn !== undefined || decision.bargeIn !== undefined) && (
        <div className="muted small">
          {decision.endOfTurn !== undefined && <>end of turn {decision.endOfTurn.toFixed(2)} </>}
          {decision.bargeIn !== undefined && <>barge-in {decision.bargeIn.toFixed(2)}</>}
        </div>
      )}
      <label className="slider">
        <span>confidence threshold</span>
        <input type="range" min={0} max={1} step={0.01} value={threshold} onChange={(e) => onThreshold(Number(e.target.value))} />
        <strong>{threshold.toFixed(2)}</strong>
      </label>
    </div>
  )
}
