/**
 * Collegamento dell'app Radio Esterna al server della radio (scelte di cristian, 24/11/2026).
 *
 * - Accesso con l'utente del pannello (POST /api/login): il server risponde con il cookie "sessione",
 *   che l'app conserva cifrato e usa per tutto il resto (anche per aprire il pannello nella scheda Regia).
 * - WebSocket /ws/esterna in HTTPS (porta 443 o quella dell'indirizzo): comandi in JSON e audio in binario.
 * - Se la rete cade si ricollega da sola; se si era in onda, al ritorno resta in onda (entro 10 minuti).
 * - Dal 26/11/2026 l'audio prova prima il WebRTC (UDP, più robusto sul 4G): la finestra fa l'offerta e qui si
 *   passa al server sullo stesso WebSocket (rtc-offerta → rtc-risposta). Finché il WebRTC non è collegato, o se
 *   non passa, l'audio va in HTTPS come prima.
 */
import WebSocket from 'ws'
import type { EsternaStatus, StatoServer } from '../shared/api'

/** Dopo quanto tempo di caduta non si torna più in onda da soli (ms). */
export const RIENTRO_MAX_MS = 10 * 60_000

/** "radio.it:9443", "https://radio.it/" … → "https://radio.it:9443" (sempre HTTPS, tranne localhost per le prove). */
export function normalizzaServer(s: string): string {
  let t = s.trim()
  if (!t) throw new Error('scrivi l\'indirizzo del server')
  if (!/^[a-z]+:\/\//i.test(t)) t = `https://${t}`
  let u: URL
  try {
    u = new URL(t)
  } catch {
    throw new Error('indirizzo del server non valido')
  }
  const locale = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  if (u.protocol !== 'https:' && !(locale && u.protocol === 'http:')) throw new Error('il server va raggiunto in https')
  return `${u.protocol}//${u.host}`
}

/** Valore del cookie "sessione" dalle intestazioni Set-Cookie della risposta di accesso. */
export function tokenDaCookie(setCookie: string[] | string | null | undefined): string | null {
  const righe = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []
  for (const r of righe) {
    const m = /(?:^|[;,]\s*)sessione=([^;,\s]+)/.exec(r)
    if (m && m[1]) return m[1]
  }
  return null
}

/** Attesa prima del prossimo tentativo (secondi): 1, 2, 4, 8, poi 10. */
export function attesa(tentativo: number): number {
  return Math.min(10, 2 ** Math.max(0, tentativo - 1))
}

type WsLike = {
  readyState: number
  send(data: string | Buffer, cb?: (err?: Error) => void): void
  close(code?: number, reason?: string): void
  terminate(): void
  on(ev: 'open', cb: () => void): void
  on(ev: 'message', cb: (data: Buffer, binary: boolean) => void): void
  on(ev: 'close', cb: (code: number, reason: Buffer) => void): void
  on(ev: 'error', cb: (e: Error) => void): void
  on(ev: 'pong', cb: () => void): void
  ping(): void
  bufferedAmount: number
}
export type WsFactory = (url: string, headers: Record<string, string>) => WsLike

/** Messaggi WebRTC verso la finestra: connessione nuova (si prova il WebRTC), risposta del server, errore. */
export type MessaggioRtc = { t: 'nuova' } | { t: 'risposta'; sdp: string } | { t: 'errore'; messaggio: string }

export interface CollegamentoDeps {
  /** Il flusso audio va ricominciato (nuova connessione): l'app rimanda l'intestazione WebM. */
  riavviaInvio: () => void
  /** WebRTC: connessione nuova o risposta del server. */
  onRtc?: (m: MessaggioRtc) => void
  onStato: (s: StatoServer) => void
  ws?: WsFactory
  now?: () => number
  versione?: string
  log?: (s: string) => void
}

/** Byte in attesa sul collegamento oltre i quali l'audio si scarta (rete troppo lenta). */
const MAX_IN_ATTESA = 512 * 1024

export class Collegamento {
  private readonly d: CollegamentoDeps
  private readonly now: () => number
  private readonly wsf: WsFactory
  private ws: WsLike | null = null
  private base = ''
  private token = ''
  private voluto = false
  private tentativo = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private ping: ReturnType<typeof setInterval> | null = null
  /** In onda secondo chi è fuori (ultimo IN ONDA / FUORI ONDA premuto). */
  private inOndaVoluto = false
  private cadutoAlle: number | null = null
  private inviati = 0
  private inviatiDa = 0
  private kbps = 0
  /** Il prossimo pezzo d'audio deve essere l'inizio di un flusso. */
  private attesaInizio = true
  private meta: { programId: string | null; testo: string } = { programId: null, testo: '' }
  private s: StatoServer = {
    collegamento: 'scollegato',
    messaggio: 'Non collegato',
    utente: null,
    stazione: '',
    esterna: null,
    regia: false,
    ritornoUrl: null,
    pannelloUrl: null,
    kbps: 0,
    caduto: false
  }

  constructor(d: CollegamentoDeps) {
    this.d = d
    this.now = d.now ?? (() => Date.now())
    this.wsf = d.ws ?? ((url, headers) => new WebSocket(url, { headers, perMessageDeflate: false }) as unknown as WsLike)
  }

  stato(): StatoServer {
    return { ...this.s }
  }

  private cambia(p: Partial<StatoServer>): void {
    this.s = { ...this.s, ...p }
    this.d.onStato(this.stato())
  }

  setMeta(programId: string | null, testo: string): void {
    this.meta = { programId, testo }
    this.manda({ t: 'meta', programId, testo })
  }

  /** IN ONDA / FUORI ONDA premuto da chi è fuori. */
  onda(on: boolean): void {
    if (on && this.s.collegamento !== 'collegato') throw new Error('non sei collegato al server')
    this.inOndaVoluto = on
    if (!on) this.cadutoAlle = null
    this.manda({ t: 'onda', on })
  }

  avvia(base: string, token: string): void {
    this.ferma()
    this.base = base
    this.token = token
    this.voluto = true
    this.tentativo = 0
    this.cambia({ pannelloUrl: `${base}/dashboard` })
    this.apri()
  }

  ferma(): void {
    this.voluto = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.ping) clearInterval(this.ping)
    this.ping = null
    const ws = this.ws
    this.ws = null
    try {
      ws?.close(1000, 'chiuso dall\'app')
    } catch {
      // già chiuso
    }
    this.inOndaVoluto = false
    this.cadutoAlle = null
    this.cambia({ collegamento: 'scollegato', messaggio: 'Non collegato', esterna: null, ritornoUrl: null, caduto: false, kbps: 0 })
  }

  private apri(): void {
    if (!this.voluto) return
    this.cambia({ collegamento: 'collegamento', messaggio: 'Collegamento al server…' })
    const url = `${this.base.replace(/^http/i, 'ws')}/ws/esterna`
    let ws: WsLike
    try {
      ws = this.wsf(url, { Cookie: `sessione=${this.token}`, 'User-Agent': `RadioEsterna/${this.d.versione ?? '?'}` })
    } catch (e) {
      return this.riprova(e instanceof Error ? e.message : String(e))
    }
    this.ws = ws
    let vivo = true
    ws.on('open', () => {
      if (this.ws !== ws) return
      this.tentativo = 0
      this.attesaInizio = true
      // dopo una caduta si resta in onda solo se non è passato troppo tempo
      const rientra = this.inOndaVoluto && (this.cadutoAlle === null || this.now() - this.cadutoAlle < RIENTRO_MAX_MS)
      if (!rientra) this.inOndaVoluto = false
      this.cadutoAlle = null
      this.manda({ t: 'hello', versione: this.d.versione, inOnda: rientra, programId: this.meta.programId, testo: this.meta.testo })
      this.cambia({ collegamento: 'collegato', messaggio: 'Collegato al server', caduto: false })
      this.d.riavviaInvio()
      this.d.onRtc?.({ t: 'nuova' })
      if (this.ping) clearInterval(this.ping)
      this.ping = setInterval(() => {
        if (this.ws !== ws) return
        if (!vivo) {
          ws.terminate()
          return
        }
        vivo = false
        try {
          ws.ping()
        } catch {
          // chiuso
        }
        this.misura()
      }, 5000)
    })
    ws.on('pong', () => (vivo = true))
    ws.on('message', (data, binary) => {
      vivo = true
      if (this.ws !== ws || binary) return
      let m: { t?: string; [k: string]: unknown }
      try {
        m = JSON.parse(data.toString('utf8'))
      } catch {
        return
      }
      if (m.t === 'benvenuto') {
        const rit = typeof m.ritorno === 'string' ? `${this.base}/api/esterna/ritorno?t=${encodeURIComponent(m.ritorno)}` : null
        this.cambia({ utente: String(m.user ?? ''), stazione: String(m.stazione ?? ''), ritornoUrl: rit })
      } else if (m.t === 'stato') {
        const e = m.stato as EsternaStatus
        this.cambia({ esterna: e, regia: m.regia === true })
      } else if (m.t === 'errore') {
        this.cambia({ messaggio: String(m.messaggio ?? 'errore del server') })
      } else if (m.t === 'rtc-risposta' && typeof m.sdp === 'string') {
        this.d.onRtc?.({ t: 'risposta', sdp: m.sdp })
      } else if (m.t === 'rtc-errore') {
        this.d.onRtc?.({ t: 'errore', messaggio: String(m.messaggio ?? 'WebRTC non disponibile') })
      }
    })
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.ping) clearInterval(this.ping)
      this.ping = null
      const testo = reason?.toString() || ''
      if (code === 4003 || code === 4009 || code === 4010) {
        // sessione scaduta, un'altra persona collegata o server senza ingresso: si smette di riprovare
        const msg =
          code === 4003
            ? 'Accesso scaduto o ruolo cambiato: entra di nuovo.'
            : code === 4009
              ? this.s.messaggio || 'C\'è già un\'altra esterna collegata.'
              : this.s.messaggio || 'Il server non ha l\'ingresso per Radio Esterna.'
        this.voluto = false
        this.inOndaVoluto = false
        this.cambia({ collegamento: 'errore', messaggio: msg, esterna: null, ritornoUrl: null, caduto: false })
        return
      }
      if (this.inOndaVoluto && this.cadutoAlle === null) this.cadutoAlle = this.now()
      this.riprova(testo || 'collegamento interrotto')
    })
    ws.on('error', (e) => {
      if (this.ws !== ws) return
      // l'errore arriva prima della chiusura: lo si scrive, la chiusura fa ripartire
      this.cambia({ messaggio: e.message.includes('401') ? 'Accesso non valido: entra di nuovo.' : e.message })
      if (e.message.includes('401')) {
        this.voluto = false
        this.cambia({ collegamento: 'errore', messaggio: 'Accesso non valido: entra di nuovo.' })
      }
    })
  }

  private riprova(motivo: string): void {
    if (!this.voluto) return
    this.tentativo++
    const s = attesa(this.tentativo)
    this.cambia({ collegamento: 'errore', messaggio: `${motivo}: riprovo tra ${s} s`, caduto: this.inOndaVoluto, kbps: 0 })
    this.timer = setTimeout(() => {
      this.timer = null
      this.apri()
    }, s * 1000)
  }

  private manda(m: unknown): void {
    const ws = this.ws
    if (!ws || ws.readyState !== 1) return
    try {
      ws.send(JSON.stringify(m))
    } catch {
      // la chiusura fa ripartire
    }
  }

  /** Offerta WebRTC della finestra, verso il server. */
  rtcOfferta(sdp: string): void {
    this.manda({ t: 'rtc-offerta', sdp })
  }

  /** La finestra lascia il WebRTC (non passa o è caduto): si torna all'HTTPS. */
  rtcChiudi(): void {
    this.manda({ t: 'rtc-chiudi' })
  }

  /** Pezzo d'audio del mixer: va al server solo se il collegamento è aperto e non è intasato. */
  audio(pezzo: Buffer, inizio: boolean): void {
    const ws = this.ws
    if (!ws || ws.readyState !== 1) return
    if (this.attesaInizio) {
      if (!inizio) return
      this.attesaInizio = false
    }
    if (ws.bufferedAmount > MAX_IN_ATTESA) {
      // rete troppo lenta: meglio ricominciare il flusso che accumulare ritardo
      this.attesaInizio = true
      this.d.riavviaInvio()
      return
    }
    this.inviati += pezzo.length
    ws.send(pezzo)
  }

  private misura(): void {
    const t = this.now()
    if (this.inviatiDa) this.kbps = Math.round((this.inviati * 8) / Math.max(1, t - this.inviatiDa))
    this.inviati = 0
    this.inviatiDa = t
    if (this.kbps !== this.s.kbps) this.cambia({ kbps: this.kbps })
  }
}

/** Accesso al server: restituisce il token della sessione (cookie) e l'utente. */
export async function accedi(base: string, utente: string, password: string, fetchFn: typeof fetch = fetch): Promise<{ token: string; nome: string; ruolo: string }> {
  let r: Response
  try {
    r = await fetchFn(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: utente, password }),
      signal: AbortSignal.timeout(15_000)
    })
  } catch (e) {
    throw new Error(`il server non risponde (${e instanceof Error ? e.message : String(e)}): controlla l'indirizzo e la rete`)
  }
  const corpo = (await r.json().catch(() => ({}))) as { error?: string; user?: { name: string; role: string } }
  if (!r.ok) throw new Error(corpo.error || `il server ha risposto ${r.status}`)
  const h = r.headers as Headers & { getSetCookie?: () => string[] }
  const token = tokenDaCookie(h.getSetCookie?.() ?? r.headers.get('set-cookie'))
  if (!token || !corpo.user) throw new Error('il server non ha dato la sessione: è aggiornato?')
  if (corpo.user.role !== 'amministratore' && corpo.user.role !== 'conduttore') {
    throw new Error('per andare in onda serve un utente conduttore o amministratore')
  }
  return { token, nome: corpo.user.name, ruolo: corpo.user.role }
}
