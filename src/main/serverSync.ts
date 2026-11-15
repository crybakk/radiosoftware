/**
 * Libreria del server per la diretta autonoma.
 *
 * - "Copia la selezione su disco": prima copia a mano (100 GB non passano dal 4G).
 * - Invio automatico dei brani nuovi o cambiati: solo nelle ore scelte (di notte) ed entro
 *   un limite di MB al giorno, perché il 4G della regia non è illimitato.
 * - Titoli corretti e volume misurato vengono mandati al server, anche per i file copiati a mano.
 */
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import type { RadioDb } from '../core/db'
import { PonteError, type LibraryMeta, type PonteClient } from '../core/ponteClient'
import { exclusionReason, gainFor, onServer, planSync, serverId, type SyncItem } from '../core/serverLibrary'
import type { Track } from '../core/types'

export interface ServerSyncStatus {
  selected: number
  selectedMb: number
  excluded: number
  /** Brani della regia sul server (null = non ancora controllato). */
  onServer: number | null
  toUpload: number | null
  toUploadMb: number | null
  uploadedTodayMb: number
  running: 'copia' | 'invio' | null
  progress: string
  lastRun: string | null
  lastError: string | null
  lastResult: string | null
}

export interface ServerTrackRow {
  id: number
  title: string
  artist: string
  bitrate: number
  reason: string | null
  choice: boolean | null
  selected: boolean
}

const MB = 1024 * 1024
/** Se la selezione chiede di togliere troppi brani dal server, meglio fermarsi e chiedere. */
const MAX_REMOVE_SHARE = 0.2

const today = (d = new Date()): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function inWindow(hour: number, from: number, to: number): boolean {
  if (from === to) return true
  return from < to ? hour >= from && hour < to : hour >= from || hour < to
}

export class ServerLibrarySync {
  private st: ServerSyncStatus = {
    selected: 0,
    selectedMb: 0,
    excluded: 0,
    onServer: null,
    toUpload: null,
    toUploadMb: null,
    uploadedTodayMb: 0,
    running: null,
    progress: '',
    lastRun: null,
    lastError: null,
    lastResult: null
  }
  private abort: AbortController | null = null
  private budgetFile: string
  private lastMetaDay = ''

  constructor(
    private readonly db: RadioDb,
    dataDir: string,
    private readonly client: () => PonteClient | null,
    private readonly onStatus: (s: ServerSyncStatus) => void
  ) {
    this.budgetFile = join(dataDir, 'libreria-server.json')
  }

  private budget(): { day: string; bytes: number } {
    try {
      const b = JSON.parse(readFileSync(this.budgetFile, 'utf8')) as { day: string; bytes: number }
      if (b.day === today()) return b
    } catch {
      // primo uso
    }
    return { day: today(), bytes: 0 }
  }

  private addBudget(bytes: number): void {
    const b = this.budget()
    b.bytes += bytes
    writeFileSync(this.budgetFile, JSON.stringify(b))
  }

  /** Brani da tenere sul server, con il loro percorso. */
  selection(): { items: SyncItem[]; excluded: number } {
    const s = this.db.getSettings()
    const folders = this.db.listFolders()
    const items: SyncItem[] = []
    let excluded = 0
    for (const { track, size, choice } of this.db.musicForServer()) {
      if (!track.enabled) continue
      const id = onServer(track, choice, s.ponte.libraryMinKbps) ? serverId(track.path, folders) : null
      if (id) items.push({ id, size, track })
      else excluded++
    }
    return { items, excluded }
  }

  status(): ServerSyncStatus {
    const { items, excluded } = this.selection()
    this.st.selected = items.length
    this.st.selectedMb = Math.round(items.reduce((a, i) => a + i.size, 0) / MB)
    this.st.excluded = excluded
    this.st.uploadedTodayMb = Math.round(this.budget().bytes / MB)
    return { ...this.st }
  }

  private emit(patch: Partial<ServerSyncStatus>): void {
    Object.assign(this.st, patch)
    this.onStatus({ ...this.st })
  }

  /** Elenco per scegliere a mano: esclusi (con il motivo) o tutti, filtrati per testo. */
  list(filter: 'esclusi' | 'tutti', q: string, limit = 300): ServerTrackRow[] {
    const min = this.db.getSettings().ponte.libraryMinKbps
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    const out: ServerTrackRow[] = []
    for (const { track, choice } of this.db.musicForServer()) {
      if (!track.enabled) continue
      if (words.length && !words.every((w) => `${track.artist} ${track.title}`.toLowerCase().includes(w))) continue
      const reason = exclusionReason(track, min)
      const selected = onServer(track, choice, min)
      // tra gli "esclusi" restano visibili anche quelli scelti a mano, per poterli rimettere com'erano
      if (filter === 'esclusi' && selected && choice === null) continue
      out.push({ id: track.id, title: track.title, artist: track.artist, bitrate: track.bitrate, reason, choice, selected })
      if (out.length >= limit) break
    }
    return out
  }

  setChoice(id: number, choice: boolean | null): void {
    this.db.setServerChoice(id, choice)
    this.emit({ toUpload: null, toUploadMb: null })
  }

  stop(): void {
    this.abort?.abort()
  }

  /** Copia la selezione in una cartella (disco USB), con gli stessi percorsi che avrà sul server. */
  async exportTo(dest: string): Promise<string> {
    if (this.st.running) throw new Error('un\'altra copia è già in corso')
    const { items } = this.selection()
    const ac = new AbortController()
    this.abort = ac
    this.emit({ running: 'copia', progress: 'preparazione…', lastError: null })
    let copied = 0
    let skipped = 0
    let failed = 0
    let bytes = 0
    try {
      for (const [i, it] of items.entries()) {
        if (ac.signal.aborted) throw new Error('copia interrotta')
        const target = join(dest, ...it.id.split('/'))
        const there = await stat(target).catch(() => null)
        if (there && there.size === it.size) {
          skipped++
          continue
        }
        try {
          await mkdir(dirname(target), { recursive: true })
          await copyFile(it.track.path, `${target}.part`)
          await rename(`${target}.part`, target)
          copied++
          bytes += it.size
        } catch (e) {
          failed++
          if ((e as NodeJS.ErrnoException).code === 'ENOSPC') throw new Error('disco pieno')
        }
        if (i % 20 === 0) this.emit({ progress: `${i + 1} di ${items.length} (${Math.round(bytes / MB)} MB copiati)` })
      }
      const result = `Copiati ${copied} brani (${Math.round(bytes / MB)} MB), ${skipped} già presenti${failed ? `, ${failed} non leggibili` : ''}.`
      this.emit({ lastResult: result })
      return result
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.emit({ lastError: msg })
      throw e
    } finally {
      this.abort = null
      this.emit({ running: null, progress: '' })
    }
  }

  /** Controllo periodico: invia i brani nuovi se è il momento giusto. */
  async tick(now = new Date()): Promise<void> {
    const p = this.db.getSettings().ponte
    if (!p.librarySync || this.st.running) return
    if (!inWindow(now.getHours(), p.librarySyncFrom, p.librarySyncTo)) return
    await this.syncNow(false).catch(() => {})
  }

  /** Allinea il server alla selezione. manual = premuto dall'utente (ignora l'orario, non il limite). */
  async syncNow(manual: boolean): Promise<string> {
    if (this.st.running) throw new Error('un\'altra copia è già in corso')
    const c = this.client()
    if (!c) throw new Error('ponte non configurato (indirizzo e token nella scheda Collegamento)')
    const s = this.db.getSettings()
    const ac = new AbortController()
    this.abort = ac
    this.emit({ running: 'invio', progress: 'controllo dei brani sul server…', lastError: null })
    try {
      const { items } = this.selection()
      const remote = await c.listLibrary()
      const plan = planSync(items, remote)
      const meta = (it: SyncItem): LibraryMeta => metaFor(it.id, it.track, s.targetLoudness)

      // togliere: con un limite di sicurezza (per esempio cartella della libreria scollegata)
      let removed = 0
      if (plan.remove.length > 50 && plan.remove.length > remote.length * MAX_REMOVE_SHARE) {
        throw new Error(
          `la selezione toglierebbe ${plan.remove.length} brani dal server su ${remote.length}: controlla che le cartelle della libreria siano collegate`
        )
      }
      for (const id of plan.remove) {
        await c.deleteLibraryFile(id)
        removed++
      }

      // titoli e volumi: una volta al giorno o quando lo chiedi
      if (manual || this.lastMetaDay !== today()) {
        const present = new Set(remote.map((r) => r.id))
        const list = items.filter((it) => present.has(it.id)).map(meta)
        for (let i = 0; i < list.length; i += 1000) await c.sendLibraryMeta(list.slice(i, i + 1000))
        this.lastMetaDay = today()
      }

      const pending = plan.upload
      this.emit({
        onServer: remote.length - removed,
        toUpload: pending.length,
        toUploadMb: Math.round(pending.reduce((a, i) => a + i.size, 0) / MB)
      })
      let sent = 0
      let sentBytes = 0
      let stopReason = ''
      for (const it of pending) {
        if (ac.signal.aborted) {
          stopReason = 'interrotto'
          break
        }
        const p = this.db.getSettings().ponte
        if (!manual && !inWindow(new Date().getHours(), p.librarySyncFrom, p.librarySyncTo)) {
          stopReason = 'fuori dalle ore di invio'
          break
        }
        if (this.budget().bytes + it.size > p.libraryDailyMb * MB) {
          stopReason = `raggiunto il limite di ${p.libraryDailyMb} MB per oggi`
          break
        }
        if (!existsSync(it.track.path)) continue
        this.emit({ progress: `invio ${sent + 1} di ${pending.length}: ${it.track.artist} - ${it.track.title}` })
        const body = Readable.toWeb(createReadStream(it.track.path)) as ReadableStream<Uint8Array>
        await c.uploadLibraryFile(meta(it), body, ac.signal)
        this.addBudget(it.size)
        sent++
        sentBytes += it.size
        this.emit({
          onServer: (this.st.onServer ?? 0) + 1,
          toUpload: pending.length - sent,
          toUploadMb: Math.round(pending.slice(sent).reduce((a, i) => a + i.size, 0) / MB)
        })
      }
      const result =
        `Inviati ${sent} brani (${Math.round(sentBytes / MB)} MB)` +
        (removed ? `, tolti ${removed}` : '') +
        (pending.length - sent ? `; ne restano ${pending.length - sent}${stopReason ? ` (${stopReason})` : ''}` : '; il server è allineato') +
        '.'
      this.emit({ lastResult: result, lastRun: new Date().toISOString() })
      return result
    } catch (e) {
      const msg = e instanceof PonteError || e instanceof Error ? e.message : String(e)
      this.emit({ lastError: msg, lastRun: new Date().toISOString() })
      throw e
    } finally {
      this.abort = null
      this.emit({ running: null, progress: '', uploadedTodayMb: Math.round(this.budget().bytes / MB) })
    }
  }
}

function metaFor(id: string, t: Track, target: number): LibraryMeta {
  return { id, title: t.title, artist: t.artist, duration: Math.round(t.duration * 10) / 10, gainDb: gainFor(t.loudness, target) }
}
