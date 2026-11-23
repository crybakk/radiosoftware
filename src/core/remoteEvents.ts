/**
 * Eventi e rotazioni della regia gestiti da remoto (pannello web e bot Telegram, richiesta del 23/11/2026).
 *
 * I comandi arrivano dal ponte e girano nella regia. Sicurezza: gli eventi con un "comando esterno"
 * (programma lanciato sul PC di regia) da remoto si vedono soltanto, e da remoto non se ne creano.
 */
import type {
  RemoteAiInfo,
  RemoteAiPlan,
  RemoteAiResult,
  RemoteCommand,
  RemoteEvent,
  RemoteEventAction,
  RemoteEventDraft,
  RemoteEventsInfo,
  RemoteRotationProfile,
  RemoteRotationRules
} from '../../ponte/controllo/src/protocol.ts'
import { nextOccurrences } from './events'
import type { EventAction, RotationProfile, ScheduledEvent, Settings, Track, TrackKind } from './types'

export type { RemoteAiInfo, RemoteEventsInfo }

export type EventCommand = Extract<
  RemoteCommand,
  {
    type:
      | 'events'
      | 'eventSave'
      | 'eventDelete'
      | 'eventEnable'
      | 'eventRun'
      | 'rotationSet'
      | 'rotationRules'
      | 'aiStatus'
      | 'aiGenerate'
      | 'aiCancel'
      | 'aiPreview'
      | 'aiApply'
  }
>

const EVENT_TYPES = new Set([
  'events',
  'eventSave',
  'eventDelete',
  'eventEnable',
  'eventRun',
  'rotationSet',
  'rotationRules',
  'aiStatus',
  'aiGenerate',
  'aiCancel',
  'aiPreview',
  'aiApply'
])

export function isEventCommand(cmd: RemoteCommand): cmd is EventCommand {
  return EVENT_TYPES.has(cmd?.type)
}

export interface RemoteEventsDeps {
  listEvents(): Promise<ScheduledEvent[]>
  /** Salva e restituisce l'elenco aggiornato (la regia lo ricarica anche nel motore). */
  saveEvent(e: Omit<ScheduledEvent, 'id'> & { id?: number }): Promise<ScheduledEvent[]>
  deleteEvent(id: number): Promise<ScheduledEvent[]>
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): Promise<void>
  runEvent(e: ScheduledEvent): Promise<void>
  getTracks(ids: number[]): Promise<Track[]>
  listGenres(): Promise<string[]>
  /** Rotazioni con l'AI (assente = non disponibili). */
  ai?: RemoteAiDeps
  now?(): Date
}

export interface RemoteAiDeps {
  status(): Promise<{ installed: boolean; modelName: string; busy: boolean }>
  generate(description: string): Promise<RemoteAiResult>
  cancel(): Promise<void>
  preview(plan: RemoteAiPlan): Promise<RemoteAiResult>
  /** Crea gli eventi e restituisce l'elenco aggiornato (già ricaricato nel motore). */
  apply(plan: RemoteAiPlan, replace: boolean): Promise<ScheduledEvent[]>
}

/**
 * Generazione da remoto: può durare minuti (PC lento, solo CPU), quindi parte in background e il pannello
 * ne chiede lo stato. Resta l'ultimo risultato finché non si applica o si rigenera.
 */
export class RemoteAiJob {
  private job: RemoteAiInfo['job'] = { state: 'libero', by: null, startedAt: null, result: null, error: null }

  async info(deps: RemoteEventsDeps): Promise<RemoteAiInfo> {
    const ai = need(deps)
    const st = await ai.status()
    const s = await deps.getSettings()
    return { installed: st.installed, modelName: st.modelName, description: s.aiDescription, job: this.job }
  }

  async run(cmd: Extract<EventCommand, { type: `ai${string}` }>, deps: RemoteEventsDeps, by: string): Promise<RemoteAiInfo | RemoteEventsInfo> {
    const ai = need(deps)
    switch (cmd.type) {
      case 'aiStatus':
        return this.info(deps)
      case 'aiGenerate': {
        const description = str(cmd.description, 4000)
        if (!description.trim()) throw new Error('scrivi prima il palinsesto')
        const st = await ai.status()
        if (!st.installed) throw new Error("il modello dell'AI non è ancora scaricato: si scarica dalla regia (Eventi → Rotazioni con l'AI)")
        if (this.job.state === 'in_corso' || st.busy) throw new Error("l'AI sta già preparando un piano: aspetta che finisca")
        const job: RemoteAiInfo['job'] = { state: 'in_corso', by, startedAt: (deps.now?.() ?? new Date()).toISOString(), result: null, error: null }
        this.job = job
        ai.generate(description).then(
          (result) => {
            if (this.job === job) this.job = { ...job, state: 'pronto', result }
          },
          (e: unknown) => {
            if (this.job === job) this.job = { ...job, state: 'errore', error: e instanceof Error ? e.message : String(e) }
          }
        )
        return this.info(deps)
      }
      case 'aiCancel':
        if (this.job.state === 'in_corso') await ai.cancel()
        else this.job = { state: 'libero', by: null, startedAt: null, result: null, error: null }
        return this.info(deps)
      case 'aiPreview': {
        const result = await ai.preview(cmd.plan)
        this.job = { state: 'pronto', by, startedAt: this.job.startedAt, result: { ...result, seconds: this.job.result?.seconds ?? 0 }, error: null }
        return this.info(deps)
      }
      case 'aiApply': {
        const list = await ai.apply(cmd.plan, cmd.replace !== false)
        this.job = { state: 'libero', by: null, startedAt: null, result: null, error: null }
        return eventsInfo(deps, list)
      }
    }
  }
}

function need(deps: RemoteEventsDeps): RemoteAiDeps {
  if (!deps.ai) throw new Error("rotazioni con l'AI non disponibili in questa regia")
  return deps.ai
}

/** Un solo lavoro dell'AI per regia. */
export const remoteAi = new RemoteAiJob()

const LOCKED = 'Questo evento lancia un comando sul PC di regia: per sicurezza si gestisce solo dalla regia'
const KINDS: (TrackKind | '')[] = ['', 'music', 'jingle', 'spot', 'news', 'program']
const HM = /^([01]\d|2[0-3]):[0-5]\d$/
const DAY = /^\d{4}-\d{2}-\d{2}$/

const hasCommand = (e: { actions: { type: string }[] }): boolean => e.actions.some((a) => a?.type === 'command')

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}
function int(v: unknown, min: number, max: number, def: number): number {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def
}
function intOrNull(v: unknown, min: number, max: number): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : null
}

/** Profilo di rotazione arrivato da fuori: solo i campi previsti, con valori nei limiti. */
export function cleanProfile(p: unknown): RotationProfile | null {
  if (!p || typeof p !== 'object') return null
  const x = p as Record<string, unknown>
  const genres = Array.isArray(x.genres) ? x.genres.map((g) => str(g, 100).trim()).filter(Boolean).slice(0, 50) : []
  return {
    name: str(x.name, 100).trim(),
    genres,
    yearFrom: intOrNull(x.yearFrom, 1900, 2100),
    yearTo: intOrNull(x.yearTo, 1900, 2100),
    artistSeparationMinutes: intOrNull(x.artistSeparationMinutes, 0, 1440),
    jingleEvery: intOrNull(x.jingleEvery, 0, 50),
    energyMin: intOrNull(x.energyMin, 1, 10),
    energyMax: intOrNull(x.energyMax, 1, 10)
  }
}

/** Un'azione arrivata da remoto; il comando esterno non è ammesso. */
export function cleanAction(a: unknown): EventAction {
  if (!a || typeof a !== 'object') throw new Error('azione non valida')
  const x = a as Record<string, unknown>
  switch (x.type) {
    case 'play':
      return { type: 'play', trackId: int(x.trackId, 0, Number.MAX_SAFE_INTEGER, 0) }
    case 'random': {
      const kind = KINDS.includes(x.kind as TrackKind) ? (x.kind as TrackKind | '') : ''
      return { type: 'random', kind, folder: str(x.folder, 1000).trim(), genre: str(x.genre, 100).trim() }
    }
    case 'playlist': {
      const placement = x.placement === 'append' || x.placement === 'replace' ? x.placement : 'front'
      return { type: 'playlist', path: str(x.path, 1000).trim(), placement }
    }
    case 'stream':
      return { type: 'stream', url: str(x.url, 1000).trim(), minutes: int(x.minutes, 1, 1440, 60), title: str(x.title, 200).trim() }
    case 'mode':
      return { type: 'mode', mode: x.mode === 'manual' ? 'manual' : 'auto' }
    case 'clear':
      return { type: 'clear' }
    case 'stop':
      return { type: 'stop' }
    case 'rotation':
      return { type: 'rotation', profile: cleanProfile(x.profile) }
    case 'replay':
      return { type: 'replay', programId: str(x.programId, 200), title: str(x.title, 200) }
    case 'news':
      return { type: 'news', sourceId: str(x.sourceId, 200), title: str(x.title, 200) }
    case 'voice': {
      const text = str(x.text, 3000).trim()
      if (!text) throw new Error("Scrivi il testo dell'annuncio")
      return { type: 'voice', text }
    }
    case 'djMix':
      return { type: 'djMix', on: x.on === true }
    case 'command':
      throw new Error('Il comando esterno si imposta solo dalla regia')
    default:
      throw new Error('azione sconosciuta')
  }
}

/** Evento arrivato da remoto, ripulito (la validazione completa la fa il database). */
export function cleanEvent(d: unknown): Omit<ScheduledEvent, 'id'> & { id?: number } {
  if (!d || typeof d !== 'object') throw new Error('evento non valido')
  const x = d as Record<string, unknown>
  const time = str(x.time, 5).trim()
  const days = Array.isArray(x.days) ? [...new Set(x.days.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v >= 0 && v <= 6))] : []
  const actions = Array.isArray(x.actions) ? x.actions.slice(0, 30).map(cleanAction) : []
  const untilTime = str(x.untilTime, 5).trim()
  const validFrom = str(x.validFrom, 10).trim()
  const validTo = str(x.validTo, 10).trim()
  const id = x.id === undefined || x.id === null ? undefined : int(x.id, 1, Number.MAX_SAFE_INTEGER, 0)
  return {
    ...(id ? { id } : {}),
    label: str(x.label, 200).trim(),
    time,
    days,
    repeatMinutes: time.startsWith('*') ? 0 : int(x.repeatMinutes, 0, 1440, 0),
    untilTime: HM.test(untilTime) ? untilTime : null,
    validFrom: DAY.test(validFrom) ? validFrom : null,
    validTo: DAY.test(validTo) ? validTo : null,
    mode: x.mode === 'hard' ? 'hard' : 'soft',
    toleranceSeconds: int(x.toleranceSeconds, 0, 3600, 0),
    actions,
    enabled: x.enabled !== false
  }
}

/** L'evento come lo vede il pannello: il testo dei comandi esterni resta nella regia. */
export function toRemoteEvent(e: ScheduledEvent): RemoteEvent {
  const locked = hasCommand(e)
  const actions = e.actions.map((a): RemoteEventAction => (a.type === 'command' ? { type: 'command', command: '' } : a))
  return { ...e, actions, ...(locked ? { locked } : {}) }
}

/** Profili di rotazione usati negli eventi (senza doppioni), più quello attivo. */
export function knownProfiles(events: ScheduledEvent[], active: RotationProfile | null): RemoteRotationProfile[] {
  const out = new Map<string, RemoteRotationProfile>()
  const add = (p: RotationProfile | null): void => {
    if (!p) return
    const key = JSON.stringify([p.name.trim().toLowerCase(), [...p.genres].sort(), p.yearFrom, p.yearTo, p.artistSeparationMinutes, p.jingleEvery, p.energyMin ?? null, p.energyMax ?? null])
    if (!out.has(key)) out.set(key, p)
  }
  add(active)
  for (const e of events) for (const a of e.actions) if (a.type === 'rotation') add(a.profile)
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name, 'it'))
}

export async function eventsInfo(deps: RemoteEventsDeps, list?: ScheduledEvent[]): Promise<RemoteEventsInfo> {
  const events = list ?? (await deps.listEvents())
  const s = await deps.getSettings()
  const now = deps.now?.() ?? new Date()
  const ids = [...new Set(events.flatMap((e) => e.actions.flatMap((a) => (a.type === 'play' && a.trackId ? [a.trackId] : []))))]
  const tracks = ids.length ? await deps.getTracks(ids) : []
  const genres = await deps.listGenres().catch(() => [] as string[])
  return {
    events: events.map(toRemoteEvent),
    next: nextOccurrences(events, now, 8).map((o) => ({ id: o.event.id, at: o.at.toISOString() })),
    rotation: s.rotationProfile,
    profiles: knownProfiles(events, s.rotationProfile),
    rules: { artistSeparationMinutes: s.artistSeparationMinutes, titleSeparationMinutes: s.titleSeparationMinutes, jingleEvery: s.jingleEvery },
    djMix: s.djMix,
    news: s.news.map((n) => ({ id: n.id, name: n.name })),
    tracks: tracks.map((t) => ({ id: t.id, title: t.title, artist: t.artist, kind: t.kind, duration: Math.max(0, (t.cueOut || t.duration) - t.cueIn) })),
    genres: genres.slice(0, 500),
    at: now.toISOString()
  }
}

async function findEvent(deps: RemoteEventsDeps, id: unknown): Promise<ScheduledEvent> {
  const ev = (await deps.listEvents()).find((e) => e.id === Number(id))
  if (!ev) throw new Error('evento non trovato (forse è stato eliminato in regia)')
  return ev
}

/** Esegue un comando su eventi e rotazioni e restituisce lo stato aggiornato. */
export async function executeEventCommand(cmd: EventCommand, deps: RemoteEventsDeps, by = '', job: RemoteAiJob = remoteAi): Promise<RemoteEventsInfo | RemoteAiInfo> {
  switch (cmd.type) {
    case 'aiStatus':
    case 'aiGenerate':
    case 'aiCancel':
    case 'aiPreview':
    case 'aiApply':
      return job.run(cmd, deps, by)
    case 'events':
      return eventsInfo(deps)
    case 'eventSave': {
      const draft = cleanEvent(cmd.event as RemoteEventDraft)
      if (draft.id) {
        const old = await findEvent(deps, draft.id)
        if (hasCommand(old)) throw new Error(LOCKED)
      }
      const missing = draft.actions.flatMap((a) => (a.type === 'play' && a.trackId ? [a.trackId] : []))
      if (missing.length) {
        const found = new Set((await deps.getTracks(missing)).map((t) => t.id))
        if (missing.some((id) => !found.has(id))) throw new Error('Uno dei brani scelti non è più nella libreria')
      }
      return eventsInfo(deps, await deps.saveEvent(draft))
    }
    case 'eventDelete': {
      const ev = await findEvent(deps, cmd.id)
      if (hasCommand(ev)) throw new Error(LOCKED)
      return eventsInfo(deps, await deps.deleteEvent(ev.id))
    }
    case 'eventEnable': {
      const ev = await findEvent(deps, cmd.id)
      if (hasCommand(ev)) throw new Error(LOCKED)
      return eventsInfo(deps, await deps.saveEvent({ ...ev, enabled: cmd.on === true }))
    }
    case 'eventRun': {
      const ev = await findEvent(deps, cmd.id)
      if (hasCommand(ev)) throw new Error(LOCKED)
      if (!ev.actions.length) throw new Error("l'evento non ha azioni")
      await deps.runEvent(ev)
      return eventsInfo(deps)
    }
    case 'rotationSet': {
      await deps.saveSettings({ rotationProfile: cmd.profile === null ? null : cleanProfile(cmd.profile) })
      return eventsInfo(deps)
    }
    case 'rotationRules': {
      const r = (cmd.rules ?? {}) as Partial<RemoteRotationRules>
      const patch: Partial<Settings> = {}
      if (r.artistSeparationMinutes !== undefined) patch.artistSeparationMinutes = int(r.artistSeparationMinutes, 0, 1440, 60)
      if (r.titleSeparationMinutes !== undefined) patch.titleSeparationMinutes = int(r.titleSeparationMinutes, 0, 10080, 180)
      if (r.jingleEvery !== undefined) patch.jingleEvery = int(r.jingleEvery, 0, 50, 4)
      if (Object.keys(patch).length) await deps.saveSettings(patch)
      return eventsInfo(deps)
    }
  }
}
