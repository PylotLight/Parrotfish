// Named JSON profiles in <userData>/profiles. Built-ins (default, Mock, baseline) are written on
// first run and can be edited; deleting one restores it next launch. settings.json keeps the active name.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUILTIN_PROFILES, PROFILE_NAME, defaultProfile, parseProfile, type Profile, type ProfileIssue } from '../shared/profile'

function fileName(name: string): string {
  return `${name.replace(/[^\w .-]/g, '_')}.json`
}

export class ProfileStore {
  private readonly dir: string
  private readonly settingsPath: string
  private cache = new Map<string, Profile>()
  private activeName = 'default'

  constructor(userData: string) {
    this.dir = join(userData, 'profiles')
    this.settingsPath = join(userData, 'settings.json')
    mkdirSync(this.dir, { recursive: true })
    for (const make of BUILTIN_PROFILES) {
      const p = make()
      if (!existsSync(join(this.dir, fileName(p.name)))) this.write(p)
    }
    this.reload()
    try {
      const s = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as { active?: unknown }
      if (typeof s.active === 'string' && this.cache.has(s.active)) this.activeName = s.active
    } catch {
      // first run
    }
  }

  readonly builtins = BUILTIN_PROFILES.map((m) => m().name)

  private write(profile: Profile): void {
    const path = join(this.dir, fileName(profile.name))
    writeFileSync(`${path}.tmp`, `${JSON.stringify(profile, null, 2)}\n`)
    renameSync(`${path}.tmp`, path)
  }

  reload(): void {
    this.cache.clear()
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const { profile } = parseProfile(JSON.parse(readFileSync(join(this.dir, f), 'utf8')))
        this.cache.set(profile.name, profile)
      } catch {
        // a broken file is skipped (the raw editor can't open it, but nothing else breaks)
      }
    }
    if (!this.cache.has('default')) this.cache.set('default', defaultProfile())
  }

  names(): string[] {
    return [...this.cache.keys()].sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)))
  }

  get(name: string): Profile {
    const p = this.cache.get(name)
    if (!p) throw new Error(`no profile named "${name}"`)
    return structuredClone(p)
  }

  get active(): Profile {
    return this.cache.get(this.activeName) ?? this.cache.get('default')!
  }

  get activeProfileName(): string {
    return this.active.name
  }

  setActive(name: string): void {
    if (!this.cache.has(name)) throw new Error(`no profile named "${name}"`)
    this.activeName = name
    writeFileSync(this.settingsPath, JSON.stringify({ active: name }, null, 2))
  }

  /** Saves (create, edit, or rename when `previousName` differs). */
  save(raw: unknown, previousName?: string): { profile: Profile; issues: ProfileIssue[] } {
    const base = previousName && this.cache.has(previousName) ? this.cache.get(previousName)! : defaultProfile()
    const result = parseProfile(raw, base)
    const { profile } = result
    if (!PROFILE_NAME.test(profile.name)) throw new Error('invalid profile name')
    this.write(profile)
    this.cache.set(profile.name, profile)
    if (previousName && previousName !== profile.name && this.cache.has(previousName)) {
      this.remove(previousName)
      if (this.activeName === previousName) this.setActive(profile.name)
    }
    return result
  }

  remove(name: string): void {
    rmSync(join(this.dir, fileName(name)), { force: true })
    this.cache.delete(name)
    if (this.activeName === name) this.setActive('default')
  }
}
