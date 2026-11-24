/**
 * Registrazione in regia dei programmi fatti dallo studio (scelte di cristian, 23/11/2026).
 *
 * - Nel pannello il programma è segnato "Va in onda dallo studio" e ha le sue fasce.
 * - 10 minuti prima della fascia si accende il tasto "Registra adesso". Se nessuno lo preme, la
 *   registrazione parte da sola all'orario. Se è già partita il tasto diventa "Segna inizio programma".
 * - 5 minuti prima della fine compare l'avviso con "Non fermare"; senza, la registrazione si ferma da
 *   sola a fine fascia più il margine del pannello. "Fine programma" la ferma a mano e segna la fine.
 * - Si può registrare anche a mano fuori fascia, scegliendo il programma.
 * - A fine registrazione si chiede al ponte cosa fare (vedi ponte/controllo/src/puntateRegia.ts): se il
 *   collegamento non è mai caduto si tiene la registrazione del ponte e il file resta sul PC; altrimenti
 *   il file parte subito verso il server. Se il ponte non risponde si riprova finché non risponde.
 */
import { createReadStream, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { Readable, Transform } from 'node:stream'

export interface ProgrammaStudio {
  id: string
  title: string
  studio?: boolean
  slots?: { days: number[]; start: string; end: string }[]
  marginMinutes?: number
}

export interface Fascia {
  programId: string
  title: string
  /** Inizio e fine nominali (ms). */
  start: number
  end: number
  /** Minuti registrati dopo la fine (margine del pannello). */
  margin: number
}

const minuti = (hm: string): number => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5))

/**
 * Fascia di un programma dallo studio in corso (fino a fine + margine) o che inizia entro `anticipoMin`.
 * Calcolata sul calendario locale come sul ponte; tra più fasce si prende quella che inizia prima.
 */
export function fasciaStudio(programs: ProgrammaStudio[], now: Date, anticipoMin: number): Fascia | null {
  let best: Fascia | null = null
  const t = now.getTime()
  for (const back of [-1, 0, 1]) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)
    for (const p of programs) {
      if (!p.studio) continue
      const margin = Math.max(0, p.marginMinutes ?? 2)
      for (const s of p.slots ?? []) {
        if (!s.days.includes(day.getDay()) || !/^\d\d:\d\d$/.test(s.start) || !/^\d\d:\d\d$/.test(s.end)) continue
        const a = minuti(s.start)
        let b = minuti(s.end)
        if (b <= a) b += 24 * 60
        const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, a).getTime()
        const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, b).getTime()
        if (t < start - anticipoMin * 60_000 || t >= end + margin * 60_000) continue
        if (!best || start < best.start) best = { programId: p.id, title: p.title, start, end, margin }
      }
    }
  }
  return best
}

export interface FineRegia {
  programId: string
  startedAt: number
  endedAt: number
  startMark: number | null
  endMark: number | null
  startAuto: boolean
  endAuto: boolean
}

export interface InvioRegistrazione extends FineRegia {
  title: string
  file: string
  /** "decidere" = chiedere al ponte; "inviare" = mandare il file; "fatto"/"tenuta-ponte" = finito. */
  stato: 'decidere' | 'inviare' | 'inviata' | 'tenuta-ponte'
  /** Ultimo errore (ponte non raggiungibile...). */
  errore?: string
  inviatiByte?: number
}

export type FaseRegistrazione =
  /** niente in vista */
  | 'riposo'
  /** fascia tra poco: tasto "Registra adesso" acceso */
  | 'pronta'
  /** si registra */
  | 'registra'
  /** si registra e la fine della fascia è vicina: avviso "Non fermare" */
  | 'avviso-fine'

export interface StatoRegistrazioneProgrammi {
  fase: FaseRegistrazione
  /** Fascia in corso o in arrivo (programma dallo studio). */
  fascia: Fascia | null
  /** Registrazione in corso. */
  corrente: {
    programId: string
    title: string
    startedAt: number
    startMark: number | null
    startAuto: boolean
    /** Fine automatica sospesa con "Non fermare". */
    nonFermare: boolean
    /** Quando si fermerà da sola (ms), null se sospeso o registrazione a mano senza fascia. */
    stopAt: number | null
    bytes: number
    problema: string | null
  } | null
  /** Registrazioni finite in attesa del ponte o in invio. */
  invii: InvioRegistrazione[]
  /** Programmi dallo studio (per la registrazione a mano). */
  programmi: { id: string; title: string }[]
  anticipoMinuti: number
  avvisoMinuti: number
}

export interface RecorderLike {
  start(title: string, programId: string | null): unknown
  stop(): Promise<{ file: string; startedAt: string; endedAt: string } | null>
  status(): { active: boolean; bytes: number; problem: string | null }
}

export interface ServerLike {
  fine(f: FineRegia): Promise<{ usa: 'ponte' | 'regia' }>
  upload(f: FineRegia, body: ReadableStream<Uint8Array>, size: number): Promise<void>
}

export interface RegistrazioneDeps {
  recorder: RecorderLike
  /** Client del ponte (null = ponte non configurato). */
  server: () => ServerLike | null
  /** Programmi del pannello (con fasce e "dallo studio"). */
  programs: () => Promise<ProgrammaStudio[]>
  /** File dove si ricordano gli invii in sospeso e l'elenco dei programmi (per quando il ponte non risponde). */
  stateFile: string
  now?: () => number
  anticipoMinuti?: number
  avvisoMinuti?: number
  /** Velocità massima di invio (kbit/s), per non togliere banda alla diretta sul 4G; 0 = nessun limite. */
  maxKbps?: number
  log?: (s: string) => void
}

interface Corrente {
  programId: string
  title: string
  startedAt: number
  startMark: number | null
  startAuto: boolean
  nonFermare: boolean
  fascia: Fascia | null
}

interface Salvato {
  invii: InvioRegistrazione[]
  programmi: ProgrammaStudio[]
  /** Fasce già gestite (inizio nominale): non si riavviano da sole dopo uno stop. */
  gestite: string[]
}

/** Limita la velocità di un flusso (byte al secondo). */
export function limitaVelocita(bytesPerSecond: number, onBytes?: (n: number) => void): Transform {
  let sent = 0
  const t0 = Date.now()
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      sent += chunk.length
      onBytes?.(sent)
      if (!bytesPerSecond) return cb(null, chunk)
      const wait = (sent / bytesPerSecond) * 1000 - (Date.now() - t0)
      if (wait > 0) setTimeout(() => cb(null, chunk), wait)
      else cb(null, chunk)
    }
  })
}

export class RegistrazioneProgrammi {
  private readonly d: RegistrazioneDeps
  private readonly now: () => number
  private readonly log: (s: string) => void
  private corrente: Corrente | null = null
  private saved: Salvato = { invii: [], programmi: [], gestite: [] }
  private timer: ReturnType<typeof setInterval> | null = null
  private refreshAt = 0
  private working = false
  private retryAt = 0
  private readonly listeners = new Set<(s: StatoRegistrazioneProgrammi) => void>()
  private lastJson = ''

  constructor(d: RegistrazioneDeps) {
    this.d = d
    this.now = d.now ?? (() => Date.now())
    this.log = d.log ?? ((s) => console.log(`[registrazione programmi] ${s}`))
    if (existsSync(d.stateFile)) {
      try {
        const s = JSON.parse(readFileSync(d.stateFile, 'utf8')) as Partial<Salvato>
        this.saved = { invii: Array.isArray(s.invii) ? s.invii : [], programmi: Array.isArray(s.programmi) ? s.programmi : [], gestite: Array.isArray(s.gestite) ? s.gestite : [] }
      } catch {
        // file rovinato: si riparte
      }
    }
  }

  private get anticipo(): number {
    return this.d.anticipoMinuti ?? 10
  }

  private get avviso(): number {
    return this.d.avvisoMinuti ?? 5
  }

  private save(): void {
    try {
      writeFileSync(`${this.d.stateFile}.tmp`, JSON.stringify(this.saved))
      renameSync(`${this.d.stateFile}.tmp`, this.d.stateFile)
    } catch (e) {
      this.log(`stato non salvato: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  onStatus(cb: (s: StatoRegistrazioneProgrammi) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(force = false): void {
    const s = this.status()
    const j = JSON.stringify(s)
    if (!force && j === this.lastJson) return
    this.lastJson = j
    for (const l of this.listeners) l(s)
  }

  private fascia(): Fascia | null {
    return fasciaStudio(this.saved.programmi, new Date(this.now()), this.anticipo)
  }

  status(): StatoRegistrazioneProgrammi {
    const now = this.now()
    const c = this.corrente
    const rec = this.d.recorder.status()
    const f = c?.fascia ?? (c ? null : this.fascia())
    const gestita = f && !c && this.saved.gestite.includes(`${f.programId}@${f.start}`)
    let fase: FaseRegistrazione = 'riposo'
    if (c) fase = c.fascia && !c.nonFermare && now >= c.fascia.end - this.avviso * 60_000 ? 'avviso-fine' : 'registra'
    else if (f && !gestita && now < f.end) fase = 'pronta'
    return {
      fase,
      fascia: gestita ? null : f,
      corrente: c
        ? {
            programId: c.programId,
            title: c.title,
            startedAt: c.startedAt,
            startMark: c.startMark,
            startAuto: c.startAuto,
            nonFermare: c.nonFermare,
            stopAt: c.fascia && !c.nonFermare ? c.fascia.end + c.fascia.margin * 60_000 : null,
            bytes: rec.bytes,
            problema: rec.problem
          }
        : null,
      invii: this.saved.invii.filter((x) => x.stato === 'decidere' || x.stato === 'inviare').map((x) => ({ ...x })),
      programmi: this.saved.programmi.filter((p) => p.studio).map((p) => ({ id: p.id, title: p.title })),
      anticipoMinuti: this.anticipo,
      avvisoMinuti: this.avviso
    }
  }

  start(intervalMs = 5000): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), intervalMs)
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Elenco dei programmi dal ponte, ogni 5 minuti (il 4G costa). */
  private async refresh(force = false): Promise<void> {
    if (!force && this.now() < this.refreshAt) return
    this.refreshAt = this.now() + 5 * 60_000
    try {
      const list = await this.d.programs()
      this.saved.programmi = list.map((p) => ({ id: p.id, title: p.title, studio: !!p.studio, slots: p.slots ?? [], marginMinutes: p.marginMinutes }))
      this.save()
    } catch {
      // ponte non raggiungibile: si usa l'ultimo elenco salvato
      this.refreshAt = this.now() + 60_000
    }
  }

  async tick(): Promise<void> {
    await this.refresh()
    const now = this.now()
    const c = this.corrente
    if (c) {
      // fine automatica: fine fascia più margine, se non sospesa
      if (c.fascia && !c.nonFermare && now >= c.fascia.end + c.fascia.margin * 60_000) await this.finisci(null, true)
    } else {
      const f = this.fascia()
      const key = f ? `${f.programId}@${f.start}` : ''
      // all'orario parte da sola, se nessuno l'ha avviata prima (o fermata in questa fascia)
      if (f && now >= f.start && now < f.end && !this.saved.gestite.includes(key)) {
        this.avvia(f.programId, f.title, true, f)
      }
    }
    await this.lavora()
    this.emit()
  }

  private avvia(programId: string, title: string, auto: boolean, f: Fascia | null): void {
    this.d.recorder.start(title, programId)
    this.corrente = { programId, title, startedAt: this.now(), startMark: null, startAuto: auto, nonFermare: false, fascia: f }
    if (f) {
      this.saved.gestite = [...this.saved.gestite.slice(-50), `${f.programId}@${f.start}`]
      this.save()
    }
    this.log(`registrazione ${auto ? 'partita da sola' : 'avviata'}: ${title}`)
  }

  /** Rilegge subito l'elenco dei programmi dal server (per esempio appena ci si collega). */
  async aggiornaProgrammi(): Promise<void> {
    await this.refresh(true)
    this.emit(true)
  }

  /** Tasto ⏺: "Registra adesso" (fascia in arrivo), "Segna inizio" (già partita), o registrazione a mano. */
  registra(programId?: string): StatoRegistrazioneProgrammi {
    if (this.corrente) {
      this.corrente.startMark = this.now()
      this.log(`segnato l'inizio di ${this.corrente.title}`)
    } else {
      const f = this.fascia()
      const usaFascia = f && (!programId || programId === f.programId) && !this.saved.gestite.includes(`${f.programId}@${f.start}`)
      if (usaFascia) this.avvia(f.programId, f.title, false, f)
      else {
        const p = this.saved.programmi.find((x) => x.id === programId)
        if (!p) throw new Error('scegli il programma da registrare')
        this.avvia(p.id, p.title, false, null)
      }
    }
    this.emit(true)
    return this.status()
  }

  /** "Non fermare": la registrazione continua oltre la fascia finché non si preme "Fine programma". */
  nonFermare(): StatoRegistrazioneProgrammi {
    if (!this.corrente) throw new Error('nessuna registrazione in corso')
    this.corrente.nonFermare = true
    this.emit(true)
    return this.status()
  }

  /** "Fine programma": ferma e segna la fine (adesso, o `endMark` se dato: per esempio l'ultimo FUORI ONDA). */
  async fine(endMark?: number): Promise<StatoRegistrazioneProgrammi> {
    if (!this.corrente) throw new Error('nessuna registrazione in corso')
    const c = this.corrente
    const fineSegnata = endMark !== undefined && endMark > c.startedAt && endMark <= this.now() ? endMark : this.now()
    await this.finisci(fineSegnata, false)
    void this.lavora().then(() => this.emit())
    this.emit(true)
    return this.status()
  }

  private async finisci(endMark: number | null, endAuto: boolean): Promise<void> {
    const c = this.corrente
    if (!c) return
    this.corrente = null
    const done = await this.d.recorder.stop()
    if (!done) {
      this.log(`registrazione di ${c.title} senza audio: niente da inviare`)
      return
    }
    this.saved.invii.push({
      programId: c.programId,
      title: c.title,
      file: done.file,
      startedAt: c.startedAt,
      endedAt: this.now(),
      startMark: c.startMark,
      endMark,
      startAuto: c.startAuto,
      endAuto,
      stato: 'decidere'
    })
    this.saved.invii = this.saved.invii.slice(-100)
    this.retryAt = 0
    this.save()
  }

  /** Chiede al ponte cosa fare delle registrazioni finite e manda i file che servono. Una alla volta. */
  private async lavora(): Promise<void> {
    if (this.working || this.now() < this.retryAt) return
    const x = this.saved.invii.find((i) => i.stato === 'decidere' || i.stato === 'inviare')
    if (!x) return
    const server = this.d.server()
    if (!server) return
    this.working = true
    const f: FineRegia = { programId: x.programId, startedAt: x.startedAt, endedAt: x.endedAt, startMark: x.startMark, endMark: x.endMark, startAuto: x.startAuto, endAuto: x.endAuto }
    try {
      if (x.stato === 'decidere') {
        const r = await server.fine(f)
        x.stato = r.usa === 'ponte' ? 'tenuta-ponte' : 'inviare'
        delete x.errore
        this.log(r.usa === 'ponte' ? `${x.title}: il ponte ha la registrazione completa, il file resta sul PC` : `${x.title}: invio il file della regia al server`)
        this.save()
        this.emit()
      }
      if (x.stato === 'inviare') {
        if (!existsSync(x.file)) throw new Error('il file della registrazione non c\'è più sul PC')
        const size = statSync(x.file).size
        const kbps = this.d.maxKbps ?? 0
        let last = 0
        const body = Readable.toWeb(
          createReadStream(x.file).pipe(
            limitaVelocita((kbps * 1000) / 8, (n) => {
              x.inviatiByte = n
              if (n - last > 1024 * 1024) {
                last = n
                this.emit()
              }
            })
          )
        ) as ReadableStream<Uint8Array>
        await server.upload(f, body, size)
        x.stato = 'inviata'
        delete x.errore
        delete x.inviatiByte
        this.log(`${x.title}: registrazione inviata al server`)
        this.save()
      }
    } catch (e) {
      x.errore = e instanceof Error ? e.message : String(e)
      delete x.inviatiByte
      // si riprova tra un minuto
      this.retryAt = this.now() + 60_000
      this.save()
    } finally {
      this.working = false
    }
    this.emit()
    if (this.now() >= this.retryAt) void this.lavora()
  }

  /** Alla chiusura della regia: la registrazione in corso si chiude (e si gestirà al prossimo avvio). */
  async chiudi(): Promise<void> {
    this.stop()
    await this.finisci(this.now(), false)
  }
}
