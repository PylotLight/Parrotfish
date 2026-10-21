import { useCallback, useEffect, useState } from 'react'
import type { LocalInferenceStatus } from '../../../shared/local-inference'

const api = window.parrotfish
const bytes = (value?: number): string => {
  if (value == null) return ''
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(0)} KB`
  return `${(value / 1024 ** 2).toFixed(1)} MB`
}

export function LocalModels() {
  const [models, setModels] = useState<LocalInferenceStatus[]>([])
  const [warming, setWarming] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try { setModels(await api.local.status()) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])

  useEffect(() => {
    let mounted = true
    const liveStages = new Set<LocalInferenceStatus['stage']>()
    const off = api.on('local:status', (status) => {
      liveStages.add(status.stage)
      if (mounted) setModels((current) => [...current.filter((item) => item.stage !== status.stage), status])
    })
    // Subscribe first so status changes during the query are not missed.
    void api.local.status().then((items) => { if (mounted) setModels((current) => [...items.filter((item) => !liveStages.has(item.stage)), ...current.filter((item) => liveStages.has(item.stage))]) }).catch((e) => { if (mounted) setError(e instanceof Error ? e.message : String(e)) })
    return () => { mounted = false; off() }
  }, [])

  const prepare = async (): Promise<void> => {
    setWarming(true)
    setError('')
    try {
      const result = await api.local.warm()
      if (!result.ok) setError(result.error || 'Could not prepare local models.')
      await refresh()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setWarming(false) }
  }

  return (
    <section className="local-readiness" aria-label="Local loop model readiness">
      <div className="local-readiness-head">
        <div><div className="local-title">Local loop</div><div className="muted small">Speech in and speech out stay on this device.</div></div>
        <button className="primary" onClick={() => void prepare()} disabled={warming}>{warming ? 'Preparing…' : 'Prepare models'}</button>
      </div>
      <div className="local-model-list">
        {models.length ? models.map((model) => {
          const progress = model.total && model.total > 0 ? Math.min(100, (model.received ?? 0) / model.total * 100) : 0
          return <div className="local-model" key={model.stage}>
            <div className="local-model-top"><strong>{model.label}</strong><span className={`local-state local-${model.state}`}>{model.state}</span></div>
            <div className="muted small">{model.stage === 'stt' ? 'Speech recognition' : 'Speech synthesis'}{model.backend ? ` · ${model.backend}` : ''}</div>
            {model.state === 'downloading' && model.total != null && <div className="local-progress-wrap"><div className="local-progress"><span style={{ width: `${progress}%` }} /></div><span className="muted small">{bytes(model.received)} / {bytes(model.total)}</span></div>}
            {model.detail && <div className={model.state === 'error' ? 'error small' : 'muted small'}>{model.detail}</div>}
          </div>
        }) : <div className="muted small">Checking local speech models…</div>}
      </div>
      {error && <div className="error small local-error">{error} <button className="ghost" onClick={() => void prepare()} disabled={warming}>Retry prepare</button></div>}
      <div className="muted small local-note">Local loop repeats the transcript through speech recognition and speech synthesis; it does not use an LLM or run actions. Use headphones to avoid the speaker being picked up by the microphone.</div>
    </section>
  )
}
