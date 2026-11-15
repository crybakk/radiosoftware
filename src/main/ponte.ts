import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RadioDb } from '../core/db'
import { backupDue, parsePonteHost, PonteClient, type PonteAlarm, type PonteBackup, type ListenerStats, type PonteProgram, type PonteState } from '../core/ponteClient'
import { pickReplay } from '../core/eventActions'
import type { PonteSettings, Track } from '../core/types'
import { Uplink, type UplinkStatus } from '../core/uplink'
import { RemoteLink, remoteTrack, remoteUrl, type RemoteCommand, type RemoteLinkStatus, type RemoteState } from '../core/remote'

export interface StudioReport {
  mode: 'auto' | 'manual'
  onAir: boolean
  artist: string
  title: string
}

export interface PonteStatus {
  uplink: UplinkStatus
  remote: RemoteLinkStatus
  /** Il servizio di controllo risponde? null = non configurato. */
  controlOk: boolean | null
  controlError: string | null
  alarms: PonteAlarm[]
  lastBackup: string | null
  backupError: string | null
  backupRunning: boolean
}

const HEARTBEAT_MS = 15_000
const RESTORE_FILE = 'radio-ripristino.db'

/**
 * Prima di aprire il database: se è stato scaricato un backup da ripristinare lo mette al posto
 * di quello attuale, tenendo da parte la versione precedente.
 */
export function applyPendingRestore(dataDir: string): string | null {
  const pending = join(dataDir, RESTORE_FILE)
  if (!existsSync(pending)) return null
  const current = join(dataDir, 'radio.db')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const kept = join(dataDir, `radio-prima-del-ripristino-${stamp}.db`)
  if (existsSync(current)) renameSync(current, kept)
  for (const ext of ['-wal', '-shm']) rmSync(current + ext, { force: true })
  renameSync(pending, current)
  return kept
}

/** Tutto ciò che riguarda il ponte dal lato regia: invio audio, segnali di vita, titoli, backup. */
export class PonteService {
  private uplink: Uplink
  private settings: PonteSettings | null = null
  private sampleRate = 0
  private capturing = false
  private report: StudioReport = { mode: 'manual', onAir: false, artist: '', title: '' }
  private remote: RemoteLink
  /** Esegue nell'interfaccia i comandi che riguardano la messa in onda. */
  runInUi: (cmd: RemoteCommand, by: string) => Promise<unknown> = async () => {
    throw new Error('regia non pronta')
  }
  private status: Omit<PonteStatus, 'uplink' | 'remote'> = {
    controlOk: null,
    controlError: null,
    alarms: [],
    lastBackup: null,
    backupError: null,
    backupRunning: false
  }
  private timer: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<(s: PonteStatus) => void>()
  private db: RadioDb
  private dataDir: string
  private lastBackupFile: string

  constructor(db: RadioDb, dataDir: string, ffmpegPath: string | null) {
    this.db = db
    this.dataDir = dataDir
    this.uplink = new Uplink(ffmpegPath ?? 'ffmpeg')
    this.uplink.onStatus(() => this.emit())
    this.remote = new RemoteLink(
      async (cmd, by) => {
        // la ricerca la fa direttamente il database, il resto lo esegue il motore di messa in onda
        if (cmd.type === 'search') return this.db.searchTracks({ text: String(cmd.q ?? ''), limit: 50 }).tracks.map(remoteTrack)
        return this.runInUi(cmd, by)
      },
      () => this.emit()
    )
    this.lastBackupFile = join(dataDir, 'ultimo-backup.txt')
    try {
      this.status.lastBackup = readFileSync(this.lastBackupFile, 'utf8').trim() || null
    } catch {
      // nessun backup fatto finora
    }
  }

  onStatus(cb: (s: PonteStatus) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  getStatus(): PonteStatus {
    return { ...this.status, uplink: this.uplink.getStatus(), remote: this.remote.getStatus() }
  }

  private emit(): void {
    const s = this.getStatus()
    for (const l of this.listeners) l(s)
  }

  client(): PonteClient | null {
    const p = this.settings
    if (!p || !p.host.trim() || !p.controlToken) return null
    return new PonteClient(p.host, p.controlPort, p.controlToken, p.controlHttps)
  }

  private srtHost(): string {
    return parsePonteHost(this.settings?.host ?? '').hostname
  }

  applySettings(p: PonteSettings): void {
    this.settings = p
    this.syncUplink()
    if (p.remoteControl && p.host.trim() && p.controlToken) this.remote.start(remoteUrl(p.host, p.controlPort, p.controlHttps), p.controlToken)
    else this.remote.stop()
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), HEARTBEAT_MS)
      void this.tick()
    }
  }

  /** L'interfaccia ha avviato (o fermato) la cattura dell'audio da inviare. */
  setCapture(active: boolean, sampleRate: number): void {
    this.capturing = active
    this.sampleRate = sampleRate
    this.syncUplink()
  }

  private syncUplink(): void {
    const p = this.settings
    if (p?.enabled && this.srtHost() && this.capturing && this.sampleRate > 0) {
      this.uplink.start(
        { host: this.srtHost(), srtPort: p.srtPort, passphrase: p.passphrase, latencyMs: p.latencyMs, bitrateKbps: p.bitrateKbps },
        this.sampleRate
      )
    } else if (this.uplink.getStatus().state !== 'spento') {
      this.uplink.stop()
    }
  }

  writePcm(pcm: Uint8Array): void {
    this.uplink.write(pcm)
  }

  setReport(r: StudioReport): void {
    this.report = r
  }

  /** Stato della regia per il pannello remoto. */
  sendRemoteState(state: RemoteState): void {
    this.remote.sendState({ ...state, uplink: this.uplink.getStatus().state })
  }

  /** Un brano è andato in onda: titolo agli Icecast (non per jingle e spot). */
  onTrackStart(track: Track): void {
    const c = this.client()
    if (!c || !this.settings?.sendMetadata || !this.settings.enabled) return
    if (track.kind === 'jingle' || track.kind === 'spot') return
    c.metadata(track.artist, track.title, Math.max(0, (track.cueOut || track.duration) - track.cueIn)).catch(() => {
      // non è grave: il prossimo brano riproverà
    })
  }

  private async tick(): Promise<void> {
    const c = this.client()
    if (!c) {
      if (this.status.controlOk !== null) {
        this.status = { ...this.status, controlOk: null, controlError: null, alarms: [] }
        this.emit()
      }
      return
    }
    try {
      const up = this.uplink.getStatus()
      const alarms = await c.heartbeat({
        ...this.report,
        uplink: up.state,
        uplinkMessage: up.message,
        reconnects: up.reconnects
      })
      this.status = { ...this.status, controlOk: true, controlError: null, alarms }
    } catch (e) {
      this.status = { ...this.status, controlOk: false, controlError: e instanceof Error ? e.message : String(e) }
    }
    this.emit()
    const last = this.status.lastBackup ? new Date(this.status.lastBackup) : null
    if (this.settings && backupDue(new Date(), this.settings.backupHour, last) && !this.status.backupRunning) {
      await this.backupNow().catch(() => {})
    }
  }

  async backupNow(): Promise<string> {
    const c = this.client()
    if (!c) throw new Error('Ponte non configurato: servono indirizzo e token')
    this.status = { ...this.status, backupRunning: true }
    this.emit()
    const tmp = join(this.dataDir, `.backup-${Date.now()}.db`)
    try {
      this.db.backupTo(tmp)
      const name = await c.uploadBackup(readFileSync(tmp))
      const at = new Date().toISOString()
      writeFileSync(this.lastBackupFile, at)
      this.status = { ...this.status, lastBackup: at, backupError: null }
      return name
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.status = { ...this.status, backupError: msg }
      throw new Error(msg)
    } finally {
      rmSync(tmp, { force: true })
      this.status = { ...this.status, backupRunning: false }
      this.emit()
    }
  }

  async listBackups(): Promise<PonteBackup[]> {
    const c = this.client()
    if (!c) throw new Error('Ponte non configurato: servono indirizzo e token')
    return c.listBackups()
  }

  /** Scarica il backup scelto; verrà messo al posto del database al prossimo avvio. */
  async prepareRestore(name: string): Promise<void> {
    const c = this.client()
    if (!c) throw new Error('Ponte non configurato: servono indirizzo e token')
    const data = await c.downloadBackup(name)
    // controllo minimo: dev'essere un database SQLite
    if (Buffer.from(data.subarray(0, 15)).toString('latin1') !== 'SQLite format 3') throw new Error('Il file scaricato non è un database valido')
    writeFileSync(join(this.dataDir, RESTORE_FILE), data)
  }

  async remoteState(): Promise<PonteState> {
    const c = this.client()
    if (!c) throw new Error('Ponte non configurato: servono indirizzo e token')
    return c.state()
  }

  async listenerStats(periodo: 'giorno' | 'settimana', data: string): Promise<ListenerStats> {
    const c = this.client()
    if (!c) throw new Error('Ponte non configurato: servono indirizzo e token')
    return c.listenerStats(periodo, data)
  }

  /** Programmi del server con le puntate pubblicate (repliche). */
  async listPrograms(): Promise<PonteProgram[]> {
    const c = this.client()
    if (!c) throw new Error('Ponte non configurato: servono indirizzo e token')
    return c.listPrograms()
  }

  /** Brano per la replica di una puntata (la più recente del programma se manca episodeId). */
  async replayTrack(programId: string, episodeId?: string): Promise<Track | null> {
    return pickReplay(await this.listPrograms(), programId, episodeId)
  }

  async testNotification(): Promise<{ ok: boolean; results: { channel: string; ok: boolean; error?: string }[] }> {
    const c = this.client()
    if (!c) throw new Error('Ponte non configurato: servono indirizzo e token')
    return c.testNotification()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.uplink.stop()
    this.remote.stop()
  }
}
