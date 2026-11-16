/**
 * Spazio libero sul disco del server. Prima di registrare una puntata e prima di accettare un file
 * (brani caricati dal pannello, libreria della regia, backup) si controlla che resti almeno
 * SPAZIO_MINIMO_MB (predefinito 2048): sotto la soglia si rifiuta con un errore chiaro e si apre
 * l'allarme "disco_pieno", che si chiude da solo quando lo spazio torna.
 */
import { statfsSync } from 'node:fs'

export const DEFAULT_MIN_FREE_MB = 2048

/** MB liberi per i programmi (non per root) nella cartella; null se non si riesce a leggere. */
export function freeMB(dir: string): number | null {
  try {
    const s = statfsSync(dir)
    return (Number(s.bavail) * Number(s.bsize)) / (1024 * 1024)
  } catch {
    return null
  }
}

export interface DiskGuardOptions {
  /** Cartelle da controllare (dati e musica possono stare su dischi diversi). */
  dirs: string[]
  minFreeMB: number
  /** Allarme aperto (true, con il messaggio) o chiuso (false). */
  onAlarm: (full: boolean, detail: string) => void
  /** Sostituibile nei test. */
  free?: (dir: string) => number | null
}

export class DiskGuard {
  private readonly o: DiskGuardOptions
  private full = false

  constructor(o: DiskGuardOptions) {
    this.o = o
  }

  /**
   * null se c'è spazio, altrimenti il motivo (in italiano, da mostrare a chi carica).
   * Ogni controllo aggiorna l'allarme. Se lo spazio non si legge si lascia passare.
   */
  check(dir?: string): string | null {
    const dirs = dir ? [dir] : this.o.dirs
    let problem: string | null = null
    let detail = ''
    for (const d of dirs) {
      const mb = (this.o.free ?? freeMB)(d)
      if (mb !== null && mb < this.o.minFreeMB) {
        const n = Math.max(0, Math.floor(mb))
        problem = `spazio sul disco del server quasi finito (${n} MB liberi, ne servono almeno ${this.o.minFreeMB}): libera spazio e riprova`
        detail = `${n} MB liberi in ${d}, soglia ${this.o.minFreeMB} MB`
        break
      }
    }
    // un controllo su una cartella sola non chiude l'allarme aperto per un'altra
    if (problem && !this.full) {
      this.full = true
      this.o.onAlarm(true, detail)
    } else if (!problem && this.full && !dir) {
      this.full = false
      this.o.onAlarm(false, '')
    }
    return problem
  }

  isFull(): boolean {
    return this.full
  }
}
