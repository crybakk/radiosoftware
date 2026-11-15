/**
 * Libreria del server per la diretta autonoma.
 *
 * - "Copia la selezione su disco": prima copia a mano (100 GB non passano dal 4G).
 * - Invio automatico dei brani nuovi o cambiati: solo nelle ore scelte (di notte) ed entro
 *   un limite di MB al giorno, perché il 4G della regia non è illimitato.
 * - Titoli corretti e volume misurato vengono mandati al server, anche per i file copiati a mano.
 */
import { createReadStream, createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { catalogParts, withCounter } from '../core/catalog'
import { NotAudioError, readFileInfo } from '../core/scanner'
import type { RadioDb } from '../core/db'
import { PonteError, type LibraryMeta, type PonteClient, type UploadedTrack } from '../core/ponteClient'
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
  /** Impronte audio sul server (null = non ancora controllato). */
  fingerprintsOnServer: number | null
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
/** Il server non accetta file più grandi di così (MAX_UPLOAD_BYTES in ponte/controllo/src/server.ts). */
export const SERVER_MAX_FILE = 300 * MB

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
    lastResult: null,
    fingerprintsOnServer: null
  }
  /** Brani appena scaricati dal server e catalogati (per avviare analisi, impronte e MusicBrainz). */
  onCatalogued: (trackIds: number[]) => void = () => {}
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
    // due file della regia con lo stesso percorso sul server (cartelle con lo stesso nome, ".x" e "_x"):
    // si tiene il primo, altrimenti ogni notte si ricaricherebbero a vicenda
    const seen = new Set<string>()
    for (const { track, size, choice } of this.db.musicForServer()) {
      if (!track.enabled) continue
      const id = onServer(track, choice, s.ponte.libraryMinKbps) ? serverId(track.path, folders) : null
      if (id && !seen.has(id)) {
        seen.add(id)
        items.push({ id, size, track })
      } else excluded++
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
          // niente file a metà sul disco (finirebbero sul server con rsync)
          await rm(`${target}.part`, { force: true }).catch(() => {})
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

      // brani caricati dal pannello: scendono in regia e vengono catalogati
      const down = await this.downloadUploaded(c, ac.signal, manual)
      // impronte audio per il riconoscimento nelle esterne
      const fpSent = await this.syncFingerprints(c, manual)

      const pending = plan.upload
      this.emit({
        onServer: remote.length - removed,
        toUpload: pending.length,
        toUploadMb: Math.round(pending.reduce((a, i) => a + i.size, 0) / MB)
      })
      let sent = 0
      let sentBytes = 0
      let stopReason = ''
      // file che il server non accetterà mai: si saltano, senza bloccare quelli dopo
      let tooBig = 0
      let refused = 0
      let refusedMsg = ''
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
        if (it.size > SERVER_MAX_FILE || it.size > p.libraryDailyMb * MB) {
          tooBig++
          continue
        }
        if (this.budget().bytes + it.size > p.libraryDailyMb * MB) {
          stopReason = `raggiunto il limite di ${p.libraryDailyMb} MB per oggi`
          break
        }
        if (!existsSync(it.track.path)) continue
        this.emit({ progress: `invio ${sent + 1} di ${pending.length}: ${it.track.artist} - ${it.track.title}` })
        // i byte partiti contano nel limite del giorno anche se il 4G cade a metà
        let read = 0
        const file = createReadStream(it.track.path)
        file.on('data', (chunk) => (read += chunk.length))
        const body = Readable.toWeb(file) as ReadableStream<Uint8Array>
        try {
          await c.uploadLibraryFile(meta(it), body, ac.signal)
        } catch (e) {
          file.destroy()
          if (read) this.addBudget(read)
          // il server ha risposto di no (percorso o file non validi): si passa al prossimo;
          // se invece non risponde (4G, ponte spento) ci si ferma e si riprova la volta dopo
          if (e instanceof PonteError && e.status !== undefined && e.status >= 400 && e.status < 500 && e.status !== 401) {
            refused++
            refusedMsg = e.message
            continue
          }
          throw e
        }
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
        (down.done ? `Scaricati e catalogati ${down.done} brani caricati dal pannello. ` : '') +
        (down.left ? `Ne restano da scaricare ${down.left}. ` : '') +
        (fpSent ? `Inviate ${fpSent} impronte audio. ` : '') +
        `Inviati ${sent} brani (${Math.round(sentBytes / MB)} MB)` +
        (removed ? `, tolti ${removed}` : '') +
        (pending.length - sent - tooBig - refused
          ? `; ne restano ${pending.length - sent - tooBig - refused}${stopReason ? ` (${stopReason})` : ''}`
          : tooBig || refused
            ? ''
            : '; il server è allineato') +
        (tooBig ? `; ${tooBig} saltati perché troppo grandi (oltre ${Math.round(Math.min(SERVER_MAX_FILE, s.ponte.libraryDailyMb * MB) / MB)} MB)` : '') +
        (refused ? `; ${refused} rifiutati dal server (${refusedMsg})` : '') +
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
  /**
   * Brani caricati dal pannello sul server: si scaricano nella prima cartella della musica come
   * "Artista/Titolo.ext", si aggiungono alla libreria e sul server prendono il percorso della regia,
   * così non tornano indietro con l'invio notturno. Rispettano il limite di MB del giorno.
   */
  async downloadUploaded(c: PonteClient, signal: AbortSignal, manual: boolean): Promise<{ done: number; left: number }> {
    const folders = this.db.listFolders()
    const root = folders.find((f) => f.kind === 'music')
    if (!root) return { done: 0, left: 0 }
    const list: UploadedTrack[] = await c.listUploaded()
    let done = 0
    for (const [i, u] of list.entries()) {
      if (signal.aborted) return { done, left: list.length - i }
      const p = this.db.getSettings().ponte
      if (!manual && !inWindow(new Date().getHours(), p.librarySyncFrom, p.librarySyncTo)) return { done, left: list.length - i }
      if (this.budget().bytes + u.size > p.libraryDailyMb * MB) return { done, left: list.length - i }
      const [dir, name] = catalogParts(u)
      // stesso nome già usato da un file diverso: "Titolo (2).mp3"
      let target = ''
      for (let n = 1; n < 100; n++) {
        const t = join(root.path, dir, withCounter(name, n))
        const st = await stat(t).catch(() => null)
        if (!st || st.size === u.size) {
          target = t
          break
        }
      }
      if (!target) continue
      this.emit({ progress: `scarico dal server: ${u.artist} - ${u.title}` })
      let downloaded = false
      if (!existsSync(target)) {
        await mkdir(dirname(target), { recursive: true })
        const body = await c.downloadUploaded(u.id, signal)
        const part = `${target}.part`
        let got = 0
        const count = new Transform({
          transform(chunk: Buffer, _enc, done) {
            got += chunk.length
            done(null, chunk)
          }
        })
        try {
          await pipeline(Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>), count, createWriteStream(part))
          await rename(part, target)
        } catch (e) {
          await rm(part, { force: true })
          // anche un download interrotto ha consumato il 4G
          if (got) this.addBudget(got)
          throw e
        }
        this.addBudget(got || u.size)
        downloaded = true
      }
      // nella libreria della regia, con i dati del server se il file non ha i tag
      let info: Awaited<ReturnType<typeof readFileInfo>>
      try {
        info = await readFileInfo(target, 'music')
      } catch (e) {
        // file rovinato o non audio: si salta senza fermare gli altri
        if (!(e instanceof NotAudioError)) throw e
        this.emit({ progress: `file non audio dal server, saltato: ${u.artist} - ${u.title}` })
        continue
      }
      if (!info.title || info.title === name.replace(/\.[^.]+$/, '')) info.title = u.title || info.title
      if (!info.artist) info.artist = u.artist
      const st = await stat(target)
      const id = this.db.upsertScanned({ ...info, size: st.size, mtime: st.mtimeMs })
      this.db.mbRequeue(id)
      // caricato apposta per il server: resta sul server anche se la regola lo escluderebbe
      // (per esempio sotto i 192 kbps), altrimenti l'invio dopo lo toglierebbe
      if (downloaded) this.db.setServerChoice(id, true)
      const sid = serverId(target, folders)
      if (sid) {
        try {
          await c.moveUploaded(u.id, sid)
        } catch (e) {
          // 409: sul server c'è già un file diverso con quel nome; il brano resta in regia, si va avanti
          if (!(e instanceof PonteError && e.status === 409)) throw e
          this.emit({ progress: `sul server esiste già un file diverso: ${sid}` })
        }
      }
      this.onCatalogued([id])
      done++
    }
    return { done, left: 0 }
  }

  /** Allinea le impronte audio del server a quelle della regia (solo i brani cambiati o mancanti). */
  async syncFingerprints(c: PonteClient, manual: boolean): Promise<number> {
    const folders = this.db.listFolders()
    const local = new Map<string, { track: Track; n: number }>()
    for (const { track, bytes } of this.db.fingerprinted()) {
      const id = serverId(track.path, folders)
      if (id && !local.has(id)) local.set(id, { track, n: bytes / 4 })
    }
    const remote = await c.listFingerprints()
    const there = new Map(remote.map((r) => [r.id, r.n]))
    const toRemove = remote.filter((r) => !local.has(r.id)).map((r) => r.id)
    if (toRemove.length > 50 && toRemove.length > remote.length * MAX_REMOVE_SHARE) {
      throw new Error(`l'invio toglierebbe ${toRemove.length} impronte dal server su ${remote.length}: controlla che le cartelle della libreria siano collegate`)
    }
    if (toRemove.length) await c.deleteFingerprints(toRemove)
    const todo = [...local.entries()].filter(([id, l]) => there.get(id) !== l.n)
    let sent = 0
    let batch: Uint8Array[] = []
    let batchBytes = 0
    const flush = async (): Promise<void> => {
      if (!batch.length) return
      const body = new Uint8Array(batchBytes)
      let o = 0
      for (const b of batch) {
        body.set(b, o)
        o += b.length
      }
      sent += await c.uploadFingerprints(body)
      this.addBudget(batchBytes)
      batch = []
      batchBytes = 0
      this.emit({ progress: `impronte audio inviate: ${sent} di ${todo.length}` })
    }
    for (const [id, { track }] of todo) {
      const p = this.db.getSettings().ponte
      if (!manual && !inWindow(new Date().getHours(), p.librarySyncFrom, p.librarySyncTo)) break
      if (this.budget().bytes + batchBytes > p.libraryDailyMb * MB) break
      const fp = this.db.getFingerprint(track.id)
      if (!fp) continue
      const head = new TextEncoder().encode(`${JSON.stringify({ id, title: track.title, artist: track.artist, duration: Math.round(track.duration) })}\n`)
      const rec = new Uint8Array(4 + head.length + fp.length)
      new DataView(rec.buffer).setUint32(0, head.length + fp.length, true)
      rec.set(head, 4)
      rec.set(fp, 4 + head.length)
      batch.push(rec)
      batchBytes += rec.length
      if (batchBytes > 2 * MB) await flush()
    }
    await flush()
    this.emit({ fingerprintsOnServer: remote.length - toRemove.length + todo.filter(([id]) => !there.has(id)).length })
    return sent
  }
}

function metaFor(id: string, t: Track, target: number): LibraryMeta {
  return { id, title: t.title, artist: t.artist, duration: Math.round(t.duration * 10) / 10, gainDb: gainFor(t.loudness, target) }
}
