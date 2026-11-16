/**
 * AcoustID (https://acoustid.org/webservice): riconosce la registrazione dall'audio, con l'impronta Chromaprint
 * calcolata da fpcalc. Serve per i brani che la ricerca per titolo su MusicBrainz non trova (titoli scritti male,
 * versioni con nomi diversi). Serve una chiave dell'applicazione gratuita (https://acoustid.org/new-application).
 * AcoustID chiede al massimo 3 richieste al secondo.
 */
import { Throttled, ServiceError, type Fetch } from './webLimit'

const BASE = 'https://api.acoustid.org/v2/lookup'
/** Somiglianza minima dell'impronta per fidarsi del risultato. */
const MIN_SCORE = 0.85
const MAX_LENGTH_DIFF_S = 10

interface Result {
  score?: number
  recordings?: { id?: string; duration?: number }[]
}

/** La registrazione più sicura: punteggio alto e durata simile al file. */
export function pickAcoustId(results: Result[], duration: number): string | null {
  let best: { id: string; score: number; diff: number } | null = null
  for (const r of results) {
    if ((r.score ?? 0) < MIN_SCORE) continue
    for (const rec of r.recordings ?? []) {
      if (!rec.id) continue
      const diff = rec.duration && duration > 0 ? Math.abs(rec.duration - duration) : 0
      if (diff > MAX_LENGTH_DIFF_S) continue
      const score = r.score ?? 0
      if (!best || score > best.score || (score === best.score && diff < best.diff)) best = { id: rec.id, score, diff }
    }
  }
  return best?.id ?? null
}

export class AcoustId {
  private readonly http: Throttled

  constructor(
    private readonly key: () => string,
    opts: { fetch?: Fetch; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}
  ) {
    this.http = new Throttled('AcoustID', 350, opts)
  }

  /** Id della registrazione MusicBrainz, null se non riconosciuta. */
  async recording(fp: { fingerprint: string; duration: number }, signal?: AbortSignal): Promise<string | null> {
    const url = `${BASE}?${new URLSearchParams({
      client: this.key(),
      meta: 'recordings',
      duration: String(Math.round(fp.duration)),
      fingerprint: fp.fingerprint
    })}`
    // AcoustID risponde 400 con la spiegazione nel JSON, anche per la chiave sbagliata
    const r = await this.http.json<{ status?: string; results?: Result[]; error?: { code?: number; message?: string } }>(url, {}, signal, true)
    if (r?.status === 'error') {
      // 3 = impronta non valida, 8 = durata non valida: colpa del file, non riconosciuto (non si blocca la ricerca)
      if (r.error?.code === 3 || r.error?.code === 8) return null
      // 4 = chiave dell'applicazione non valida
      throw new ServiceError(r.error?.code === 4 ? 'AcoustID: chiave non valida' : `AcoustID: ${r.error?.message ?? 'errore'}`)
    }
    return pickAcoustId(r?.results ?? [], fp.duration)
  }
}
