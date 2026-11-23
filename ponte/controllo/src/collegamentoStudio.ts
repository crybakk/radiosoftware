/**
 * Registro dei collegamenti della regia dello studio al ponte (scelte di cristian, 23/11/2026).
 *
 * Serve a capire, a fine programma, se la registrazione del ponte è completa: se in quell'intervallo
 * la regia non si è mai scollegata si tiene quella del ponte e si pubblica subito; altrimenti si usa la
 * registrazione fatta in regia, da rivedere, con i segni nei punti delle interruzioni.
 * Anche un riavvio del controllo conta come interruzione: in quel momento nessuno guardava.
 * Si tengono gli ultimi 14 giorni in un file JSON.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

export type Evento = 'collegata' | 'scollegata' | 'avvio'

interface Voce {
  t: number
  e: Evento
}

export interface Interruzione {
  /** Inizio e fine dell'interruzione (ms), già ristretti all'intervallo chiesto. */
  from: number
  to: number
  /** "scollegata" = la regia è caduta; "avvio" = il server è ripartito e non sa cosa è successo prima. */
  kind: 'scollegata' | 'avvio'
}

const GIORNI = 14

export class CollegamentoStudio {
  private voci: Voce[] = []
  private readonly file: string | null
  private readonly now: () => number

  constructor(file: string | null, now: () => number = () => Date.now()) {
    this.file = file
    this.now = now
    if (file && existsSync(file)) {
      try {
        const v = JSON.parse(readFileSync(file, 'utf8')) as unknown
        if (Array.isArray(v)) this.voci = v.filter((x): x is Voce => !!x && typeof x.t === 'number' && ['collegata', 'scollegata', 'avvio'].includes(x.e))
      } catch {
        // file rovinato: si riparte da vuoto
      }
    }
  }

  /** Il controllo è appena partito. */
  avvio(): void {
    this.add('avvio')
  }

  /** Evento da Liquidsoap (studio_connesso / studio_scollegato) o stato letto all'avvio. */
  collegata(on: boolean): void {
    const last = this.voci.at(-1)
    // stesso stato ripetuto (es. lettura all'avvio dopo l'evento): niente voce in più
    if (last && last.e === (on ? 'collegata' : 'scollegata')) return
    this.add(on ? 'collegata' : 'scollegata')
  }

  private add(e: Evento): void {
    const t = this.now()
    this.voci.push({ t, e })
    const limite = t - GIORNI * 24 * 3600_000
    // si tiene sempre l'ultima voce prima del limite: dice lo stato all'inizio del periodo
    const i = this.voci.findIndex((v) => v.t >= limite)
    if (i > 1) this.voci = this.voci.slice(i - 1)
    this.save()
  }

  private save(): void {
    if (!this.file) return
    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.voci))
      renameSync(`${this.file}.tmp`, this.file)
    } catch (e) {
      console.error(`[studio] registro dei collegamenti non salvato: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** Interruzioni tra from e to (ms). */
  interruzioni(from: number, to: number): Interruzione[] {
    const out: Interruzione[] = []
    // stato all'inizio dell'intervallo: l'ultima voce prima di from (nessuna voce = non si sa → interruzione)
    const prima = [...this.voci].reverse().find((v) => v.t <= from)
    let giu: { at: number; kind: Interruzione['kind'] } | null = !prima || prima.e !== 'collegata' ? { at: from, kind: prima?.e === 'avvio' ? 'avvio' : 'scollegata' } : null
    for (const v of this.voci) {
      if (v.t <= from || v.t >= to) continue
      if (v.e === 'collegata') {
        if (giu) out.push({ from: giu.at, to: v.t, kind: giu.kind })
        giu = null
      } else if (!giu) {
        giu = { at: v.t, kind: v.e }
      }
      // un riavvio durante un'interruzione resta la stessa interruzione
    }
    if (giu) out.push({ from: giu.at, to, kind: giu.kind })
    return out
  }
}
