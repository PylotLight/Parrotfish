import { useEffect, useState } from 'react'
import type { ProviderInfo } from '../../../core/registry'
import type { PhononProgress } from '../../../shared/api'
import type { CatalogVoice } from '../../../shared/phonon-voices'
import { DEMO_TOOLS, STAGES, type Profile, type ProfileIssue, type SidecarConfig, type Stage } from '../../../shared/profile'
import { ROUTER_CHOICES, type RouterChoice } from '../../../shared/types'

const api = window.parrotfish

const STAGE_LABELS: Record<Stage, string> = { vad: 'Mic + VAD', stt: 'Speech to text', router: 'Router (System One)', tools: 'Tool caller', brain: 'Brain', escalation: 'Escalation', tts: 'Text to speech' }

function OptionField({ name, value, fallback, onChange }: { name: string; value: unknown; fallback: unknown; onChange: (v: unknown) => void }) {
  const kind = typeof (value ?? fallback)
  if (kind === 'boolean') return <label className="check"><input type="checkbox" checked={Boolean(value ?? fallback)} onChange={(e) => onChange(e.target.checked)} /> {name}</label>
  if (kind === 'number')
    return (
      <label className="field inline">
        <span>{name}</span>
        <input type="number" step="any" value={String(value ?? fallback)} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
      </label>
    )
  if (kind === 'object')
    return (
      <label className="field">
        <span>{name} (JSON)</span>
        <input value={JSON.stringify(value)} onChange={(e) => { try { onChange(JSON.parse(e.target.value)) } catch { /* keep typing */ } }} />
      </label>
    )
  return (
    <label className="field">
      <span>{name}</span>
      <input type={/key/i.test(name) ? 'password' : 'text'} value={String(value ?? '')} placeholder={String(fallback ?? '')} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}

function StageEditor({ stage, profile, providers, onChange, voices }: { stage: Stage; profile: Profile; providers: ProviderInfo[]; onChange: (p: Profile) => void; voices: CatalogVoice[] }) {
  const config = profile[stage]
  const info = providers.find((p) => p.id === config.provider)
  const keys = [...new Set([...Object.keys(info?.options ?? {}), ...Object.keys(config.options)])]
  const set = (patch: Partial<typeof config>): void => onChange({ ...profile, [stage]: { ...config, ...patch } })
  return (
    <div className="stage">
      <div className="stage-head">
        <strong>{STAGE_LABELS[stage]}</strong>
        <select value={config.provider} onChange={(e) => set({ provider: e.target.value, options: { ...providers.find((p) => p.id === e.target.value)?.options } })}>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          {!info && <option value={config.provider}>{config.provider} (unknown)</option>}
        </select>
      </div>
      <div className="stage-options">
        {stage === 'tts' && config.provider === 'phonon-wasm' && (
          <label className="field inline">
            <span>voice</span>
            <select value={String(config.options.voice ?? 'default')} onChange={(e) => set({ options: { ...config.options, voice: e.target.value } })}>
              {(voices.length ? voices : [{ id: 'default', name: 'Default' } as CatalogVoice]).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                  {v.gender ? ` · ${v.gender}` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {keys
          .filter((k) => !(stage === 'tts' && config.provider === 'phonon-wasm' && k === 'voice'))
          .map((k) => (
            <OptionField key={k} name={k} value={config.options[k]} fallback={info?.options[k]} onChange={(v) => set({ options: { ...config.options, [k]: v } })} />
          ))}
      </div>
      {stage === 'vad' && (
        <div className="stage-options">
          {(['threshold', 'minSilenceMs', 'minSpeechMs', 'padMs'] as const).map((k) => (
            <OptionField key={k} name={k} value={profile.vad[k]} fallback={0} onChange={(v) => onChange({ ...profile, vad: { ...profile.vad, [k]: Number(v) } })} />
          ))}
        </div>
      )}
      {stage === 'router' && (
        <div className="stage-options">
          <OptionField name="threshold" value={profile.router.threshold} fallback={0.5} onChange={(v) => onChange({ ...profile, router: { ...profile.router, threshold: Number(v) } })} />
          <label className="field inline">
            <span>below threshold</span>
            <select value={profile.router.fallback} onChange={(e) => onChange({ ...profile, router: { ...profile.router, fallback: e.target.value as RouterChoice } })}>
              {ROUTER_CHOICES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <OptionField name="askEndOfTurn" value={profile.router.askEndOfTurn} fallback={false} onChange={(v) => onChange({ ...profile, router: { ...profile.router, askEndOfTurn: Boolean(v) } })} />
          <OptionField name="askBargeIn" value={profile.router.askBargeIn} fallback={false} onChange={(v) => onChange({ ...profile, router: { ...profile.router, askBargeIn: Boolean(v) } })} />
        </div>
      )}
      {stage === 'tools' && (
        <div className="stage-options">
          {DEMO_TOOLS.map((t) => (
            <label key={t} className="check">
              <input
                type="checkbox"
                checked={profile.tools.enabled.includes(t)}
                onChange={(e) => onChange({ ...profile, tools: { ...profile.tools, enabled: e.target.checked ? [...profile.tools.enabled, t] : profile.tools.enabled.filter((x) => x !== t) } })}
              />{' '}
              {t}
            </label>
          ))}
          <label className="field">
            <span>run_shell allowlist</span>
            <input value={profile.tools.shellAllowlist.join(' ')} onChange={(e) => onChange({ ...profile, tools: { ...profile.tools, shellAllowlist: e.target.value.split(/\s+/).filter(Boolean) } })} />
          </label>
        </div>
      )}
      {stage === 'brain' && (
        <div className="stage-options">
          <label className="field wide">
            <span>system prompt</span>
            <textarea rows={3} value={profile.brain.systemPrompt} onChange={(e) => onChange({ ...profile, brain: { ...profile.brain, systemPrompt: e.target.value } })} />
          </label>
          <OptionField name="maxHistoryTurns" value={profile.brain.maxHistoryTurns} fallback={6} onChange={(v) => onChange({ ...profile, brain: { ...profile.brain, maxHistoryTurns: Number(v) } })} />
        </div>
      )}
    </div>
  )
}

function SidecarsEditor({ profile, onChange }: { profile: Profile; onChange: (p: Profile) => void }) {
  const set = (i: number, patch: Partial<SidecarConfig>): void => onChange({ ...profile, sidecars: profile.sidecars.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  return (
    <div className="stage">
      <div className="stage-head">
        <strong>Sidecars</strong>
        <button className="ghost" onClick={() => onChange({ ...profile, sidecars: [...profile.sidecars, { id: `sidecar-${profile.sidecars.length + 1}`, label: 'New sidecar', command: '', autoStart: false }] })}>
          Add
        </button>
      </div>
      {profile.sidecars.map((s, i) => (
        <div className="sidecar-edit" key={i}>
          <input className="narrow" value={s.label} onChange={(e) => set(i, { label: e.target.value })} />
          <input className="mono" value={s.command} placeholder="command (runs in your login shell)" onChange={(e) => set(i, { command: e.target.value })} />
          <input className="mono narrow" value={s.healthUrl ?? ''} placeholder="health URL" onChange={(e) => set(i, { healthUrl: e.target.value || undefined })} />
          <label className="check">
            <input type="checkbox" checked={s.autoStart} onChange={(e) => set(i, { autoStart: e.target.checked })} /> auto
          </label>
          <button className="ghost" onClick={() => onChange({ ...profile, sidecars: profile.sidecars.filter((_, j) => j !== i) })}>
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}

export function ProfilesView({ names, active, onChanged }: { names: string[]; active: string; onChanged: () => Promise<void> }) {
  const [selected, setSelected] = useState(active)
  const [draft, setDraft] = useState<Profile | null>(null)
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [raw, setRaw] = useState('')
  const [issues, setIssues] = useState<ProfileIssue[]>([])
  const [error, setError] = useState('')
  const [providers, setProviders] = useState<Record<Stage, ProviderInfo[]> | null>(null)
  const [builtins, setBuiltins] = useState<string[]>([])
  const [voices, setVoices] = useState<CatalogVoice[]>([])
  const [phonon, setPhonon] = useState<PhononProgress | null>(null)

  useEffect(() => {
    void api.profiles.providers().then(setProviders)
    void api.profiles.list().then((l) => setBuiltins(l.builtins))
    return api.on('phonon:progress', setPhonon)
  }, [])
  useEffect(() => {
    if (!selected && active) setSelected(active)
  }, [active, selected])
  useEffect(() => {
    if (!selected) return
    void api.profiles.get(selected).then((p) => {
      setDraft(p)
      setRaw(JSON.stringify(p, null, 2))
      setIssues([])
      setError('')
    })
  }, [selected])
  useEffect(() => {
    if (draft?.tts.provider === 'phonon-wasm' && voices.length === 0) void api.phonon.voices().then(setVoices)
  }, [draft?.tts.provider, voices.length])

  const edit = (p: Profile): void => {
    setDraft(p)
    setRaw(JSON.stringify(p, null, 2))
  }

  const save = async (): Promise<void> => {
    setError('')
    let value: unknown = draft
    if (mode === 'json') {
      try {
        value = JSON.parse(raw)
      } catch (e) {
        setError(`JSON: ${e instanceof Error ? e.message : String(e)}`)
        return
      }
    }
    try {
      const result = await api.profiles.save(value, selected)
      setIssues(result.issues)
      setDraft(result.profile)
      setRaw(JSON.stringify(result.profile, null, 2))
      setSelected(result.profile.name)
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const duplicate = async (): Promise<void> => {
    if (!draft) return
    let name = `${draft.name} copy`
    for (let i = 2; names.includes(name); i++) name = `${draft.name} copy ${i}`
    const result = await api.profiles.save({ ...draft, name })
    await onChanged()
    setSelected(result.profile.name)
  }

  const remove = async (): Promise<void> => {
    if (!draft || draft.name === 'default') return
    await api.profiles.remove(draft.name)
    await onChanged()
    setSelected('default')
  }

  return (
    <div className="profiles">
      <aside className="profile-list">
        {names.map((n) => (
          <button key={n} className={n === selected ? 'profile-item selected' : 'profile-item'} onClick={() => setSelected(n)}>
            {n}
            {n === active && <span className="chip">active</span>}
            {builtins.includes(n) && <span className="chip muted">built-in</span>}
          </button>
        ))}
      </aside>
      {draft && providers && (
        <section className="profile-editor">
          <div className="row">
            <input className="title-input" value={draft.name} onChange={(e) => edit({ ...draft, name: e.target.value })} />
            <div className="seg">
              <button className={mode === 'form' ? 'active' : ''} onClick={() => setMode('form')}>
                Form
              </button>
              <button
                className={mode === 'json' ? 'active' : ''}
                onClick={() => {
                  setRaw(JSON.stringify(draft, null, 2))
                  setMode('json')
                }}
              >
                Raw JSON
              </button>
            </div>
            <span className="spacer" />
            {draft.name !== active && <button onClick={() => void api.profiles.setActive(selected).then(onChanged)}>Use this profile</button>}
            <button onClick={() => void duplicate()}>Duplicate</button>
            {draft.name !== 'default' && (
              <button className="ghost danger" onClick={() => void remove()}>
                Delete
              </button>
            )}
            <button className="primary" onClick={() => void save()}>
              Save
            </button>
          </div>
          {error && <div className="error">{error}</div>}
          {issues.length > 0 && (
            <div className="banner warn small">
              Fixed while saving: {issues.map((i) => `${i.path || 'profile'}: ${i.message}`).join(' · ')}
            </div>
          )}
          {mode === 'json' ? (
            <textarea className="raw-json mono" spellCheck={false} value={raw} onChange={(e) => setRaw(e.target.value)} />
          ) : (
            <div className="stages">
              <label className="field wide">
                <span>description</span>
                <input value={draft.description} onChange={(e) => edit({ ...draft, description: e.target.value })} />
              </label>
              {STAGES.map((s) => (
                <StageEditor key={s} stage={s} profile={draft} providers={providers[s]} onChange={edit} voices={voices} />
              ))}
              {draft.tts.provider === 'phonon-wasm' && (
                <div className="stage">
                  <div className="stage-head">
                    <strong>Phonon 31m model</strong>
                    <button onClick={() => void api.phonon.warm()}>Download + warm up</button>
                  </div>
                  <p className="muted small">~71 MB on first use (runtime, q8 weights, default voice), pinned and checksum-verified, kept in the app's data folder. Other voices are ~256 KB each, fetched when first used.</p>
                  {phonon && (
                    <p className={phonon.error ? 'error small' : 'small'}>
                      {phonon.error ? phonon.error : `${phonon.label}: ${Math.round((phonon.received / Math.max(1, phonon.total)) * 100)}%${phonon.done ? ' ✓' : ''}`}
                    </p>
                  )}
                </div>
              )}
              <div className="stage">
                <div className="stage-head">
                  <strong>Sentence splitter</strong>
                </div>
                <div className="stage-options">
                  <OptionField name="minChars" value={draft.splitter.minChars} fallback={12} onChange={(v) => edit({ ...draft, splitter: { ...draft.splitter, minChars: Number(v) } })} />
                  <OptionField name="maxChars" value={draft.splitter.maxChars} fallback={220} onChange={(v) => edit({ ...draft, splitter: { ...draft.splitter, maxChars: Number(v) } })} />
                  <OptionField name="eagerFirstClause" value={draft.splitter.eagerFirstClause} fallback={true} onChange={(v) => edit({ ...draft, splitter: { ...draft.splitter, eagerFirstClause: Boolean(v) } })} />
                </div>
              </div>
              <SidecarsEditor profile={draft} onChange={edit} />
            </div>
          )}
        </section>
      )}
    </div>
  )
}
