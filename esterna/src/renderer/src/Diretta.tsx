import { useEffect, useState } from 'react'
import type { Canale, Impostazioni, ImpostazioniMixer, Programma, StatoRegistrazioneLocale, StatoRegistrazioneProgrammi, StatoServer } from '../../shared/api'
import { DB_MAX, DB_MIN, MAX_CANALI, nuovoCanale } from '../../shared/mixer'
import { dispositivi, type Motore } from './motore'
import { testoErrore } from './App'

const api = window.esterna

function durata(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}`
}
const ora = (ms: number): string => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
const mb = (b: number): string => `${(b / 1024 / 1024).toLocaleString('it-IT', { maximumFractionDigits: 0 })} MB`

/** Indicatore di livello (dBFS, da -48 a 0). */
function Livello({ valore }: { valore: number }) {
  const db = valore > 0 ? 20 * Math.log10(valore) : -60
  const pct = Math.max(0, Math.min(100, ((db + 48) / 48) * 100))
  return (
    <div className="livello" title={`${db.toFixed(1)} dBFS`}>
      <div className={`livello-pieno ${db > -1 ? 'clip' : db > -9 ? 'alto' : ''}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

/** Livelli aggiornati 20 volte al secondo, con la tenuta del picco. */
function useLivelli(motore: Motore) {
  const [l, setL] = useState(() => motore.livelli())
  useEffect(() => {
    const tenuti = new Map<string, number>()
    let raf = 0
    let ultimo = 0
    const giro = (t: number): void => {
      raf = requestAnimationFrame(giro)
      if (t - ultimo < 50) return
      ultimo = t
      const x = motore.livelli()
      const tieni = (k: string, v: number): number => {
        const h = Math.max(v, (tenuti.get(k) ?? 0) * 0.85)
        tenuti.set(k, h)
        return h
      }
      const canali = new Map<string, number>()
      for (const [k, v] of x.canali) canali.set(k, tieni(k, v))
      setL({ canali, pc: tieni('pc', x.pc), uscita: tieni('uscita', x.uscita), riduzione: x.riduzione })
    }
    raf = requestAnimationFrame(giro)
    return () => cancelAnimationFrame(raf)
  }, [motore])
  return l
}

function Fader({ db, onChange }: { db: number; onChange: (db: number) => void }) {
  return (
    <div className="fader">
      <input type="range" min={DB_MIN} max={DB_MAX} step={0.5} value={db} onChange={(e) => onChange(Number(e.target.value))} onDoubleClick={() => onChange(0)} title="Doppio clic: 0 dB" />
      <span className="db">{db <= DB_MIN ? '−∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`}</span>
    </div>
  )
}

function Mixer({ imp, cambiaMixer, motore }: { imp: Impostazioni; cambiaMixer: (m: ImpostazioniMixer) => void; motore: Motore }) {
  const m = imp.mixer
  const l = useLivelli(motore)
  const [ingressi, setIngressi] = useState<MediaDeviceInfo[]>([])
  const [, aggiorna] = useState(0)
  useEffect(() => {
    const leggi = (): void => void dispositivi().then((d) => setIngressi(d.ingressi))
    leggi()
    navigator.mediaDevices.addEventListener('devicechange', leggi)
    motore.onCambio = () => {
      leggi()
      aggiorna((n) => n + 1)
    }
    return () => navigator.mediaDevices.removeEventListener('devicechange', leggi)
  }, [motore])
  const canale = (c: Canale, p: Partial<Canale>): void => cambiaMixer({ ...m, canali: m.canali.map((x) => (x.id === c.id ? { ...x, ...p } : x)) })
  return (
    <section className="riquadro mixer">
      <h2>🎚 Mixer</h2>
      <div className="strisce">
        {m.canali.map((c) => (
          <div key={c.id} className={`striscia ${c.muto ? 'muta' : ''}`}>
            <div className="riga">
              <input className="nome" value={c.nome} onChange={(e) => canale(c, { nome: e.target.value })} />
              <button className={`muto ${c.muto ? 'acceso' : ''}`} onClick={() => canale(c, { muto: !c.muto })}>
                {c.muto ? '🔇 Muto' : 'Muto'}
              </button>
            </div>
            <div className="riga">
              <select value={c.deviceId} onChange={(e) => canale(c, { deviceId: e.target.value })}>
                <option value="">Microfono predefinito</option>
                {ingressi.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || 'Ingresso senza nome'}
                  </option>
                ))}
              </select>
              <select value={c.parte} onChange={(e) => canale(c, { parte: e.target.value as Canale['parte'] })} title="Quale canale della scheda audio">
                <option value="stereo">Stereo</option>
                <option value="sinistro">Solo ingresso 1</option>
                <option value="destro">Solo ingresso 2</option>
              </select>
            </div>
            <Livello valore={l.canali.get(c.id) ?? 0} />
            <Fader db={c.volumeDb} onChange={(db) => canale(c, { volumeDb: db })} />
            {motore.errori.get(c.id) && <div className="errore">{motore.errori.get(c.id)}</div>}
            {m.canali.length > 1 && (
              <button className="piccolo togli" onClick={() => cambiaMixer({ ...m, canali: m.canali.filter((x) => x.id !== c.id) })}>
                Togli
              </button>
            )}
          </div>
        ))}
        <div className={`striscia pc ${!m.pc.attivo ? 'spenta' : m.pc.muto ? 'muta' : ''}`}>
          <div className="riga">
            <b className="nome">💻 Audio del computer</b>
            <label className="interruttore">
              <input type="checkbox" checked={m.pc.attivo} onChange={(e) => cambiaMixer({ ...m, pc: { ...m.pc, attivo: e.target.checked } })} /> Acceso
            </label>
          </div>
          {m.pc.attivo && (
            <>
              <div className="riga">
                <button className={`muto ${m.pc.muto ? 'acceso' : ''}`} onClick={() => cambiaMixer({ ...m, pc: { ...m.pc, muto: !m.pc.muto } })}>
                  {m.pc.muto ? '🔇 Muto' : 'Muto'}
                </button>
                <label className="interruttore" title="Di solito no: l'audio del computer lo senti già dalle casse o dalle cuffie del computer">
                  <input type="checkbox" checked={m.pc.inCuffia} onChange={(e) => cambiaMixer({ ...m, pc: { ...m.pc, inCuffia: e.target.checked } })} /> Anche in cuffia
                </label>
              </div>
              <Livello valore={l.pc} />
              <Fader db={m.pc.volumeDb} onChange={(db) => cambiaMixer({ ...m, pc: { ...m.pc, volumeDb: db } })} />
            </>
          )}
          <small>Tutto quello che suona sul computer (un programma, un video…). Attenzione: se la cuffia è l'uscita principale del computer, va in onda anche quello che senti in cuffia, ritorno compreso.</small>
          {motore.errori.get('pc') && <div className="errore">{motore.errori.get('pc')}</div>}
        </div>
      </div>
      <div className="riga uscita">
        {m.canali.length < MAX_CANALI && (
          <button onClick={() => cambiaMixer({ ...m, canali: [...m.canali, nuovoCanale(m.canali.length + 1)] })}>+ Aggiungi microfono</button>
        )}
        <span className="etichetta">Uscita verso la radio</span>
        <Livello valore={l.uscita} />
        <span className={`limitatore ${l.riduzione < -3 ? 'attivo' : ''}`} title="Il limitatore abbassa i picchi perché non distorca">
          Limitatore {l.riduzione < -0.5 ? `${l.riduzione.toFixed(0)} dB` : ''}
        </span>
      </div>
    </section>
  )
}

function Cuffia({ imp, cambiaMixer, stato, motore }: { imp: Impostazioni; cambiaMixer: (m: ImpostazioniMixer) => void; stato: StatoServer | null; motore: Motore }) {
  const m = imp.mixer
  const [uscite, setUscite] = useState<MediaDeviceInfo[]>([])
  useEffect(() => {
    const leggi = (): void => void dispositivi().then((d) => setUscite(d.uscite))
    leggi()
    navigator.mediaDevices.addEventListener('devicechange', leggi)
    return () => navigator.mediaDevices.removeEventListener('devicechange', leggi)
  }, [])
  return (
    <section className="riquadro cuffia">
      <h2>🎧 Cuffia</h2>
      <label>
        Uscita
        <select value={m.cuffiaId} onChange={(e) => cambiaMixer({ ...m, cuffiaId: e.target.value })}>
          <option value="">Uscita predefinita del computer</option>
          {uscite.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || 'Uscita senza nome'}
            </option>
          ))}
        </select>
      </label>
      <label>
        I tuoi microfoni in cuffia
        <input type="range" min={0} max={1} step={0.01} value={m.cuffiaVolume} onChange={(e) => cambiaMixer({ ...m, cuffiaVolume: Number(e.target.value) })} />
      </label>
      <label className="interruttore">
        <input type="checkbox" checked={m.ritorno} onChange={(e) => cambiaMixer({ ...m, ritorno: e.target.checked })} /> Ritorno dello studio
        {m.ritorno && <span className="nota">{!stato?.regia ? ' (la regia non è collegata)' : motore.ritornoInAscolto() ? ' (lo senti)' : ' (in arrivo…)'}</span>}
      </label>
      {m.ritorno && (
        <label>
          Volume del ritorno
          <input type="range" min={0} max={1} step={0.01} value={m.ritornoVolume} onChange={(e) => cambiaMixer({ ...m, ritornoVolume: Number(e.target.value) })} />
        </label>
      )}
      <small>Il ritorno è quello che manda la regia dello studio (arriva con un paio di secondi di ritardo). In cuffia non ascoltare la radio: arriva in ritardo e confonde.</small>
    </section>
  )
}

function Registrazione({ imp, programmi, stato }: { imp: Impostazioni; programmi: Programma[]; stato: StatoServer | null }) {
  const [s, setS] = useState<StatoRegistrazioneProgrammi | null>(null)
  const [loc, setLoc] = useState<StatoRegistrazioneLocale | null>(null)
  const [errore, setErrore] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [scelta, setScelta] = useState(imp.programId ?? '')
  useEffect(() => {
    void api.registrazione().then(setS)
    void api.statoLocale().then(setLoc)
    const off = [api.onRegistrazione(setS), api.onLocale(setLoc)]
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      for (const f of off) f()
      clearInterval(t)
    }
  }, [])
  useEffect(() => {
    if (!scelta && imp.programId) setScelta(imp.programId)
  }, [imp.programId, scelta])
  const esegui = <T,>(p: Promise<T>, then: (v: T) => void): void => {
    setErrore(null)
    p.then(then).catch((e: unknown) => setErrore(testoErrore(e)))
  }
  const c = s?.corrente
  const locale = loc?.attiva
  return (
    <section className={`riquadro registrazione ${c || locale ? 'rec' : ''}`}>
      <h2>⏺ Registrazione</h2>
      {c ? (
        <>
          <div>
            <span className="punto-rec" /> <b>{c.title}</b>: registra dalle {ora(c.startedAt)} ({durata(now - c.startedAt)}, {mb(c.bytes)})
          </div>
          <div className="nota">{c.startMark ? `Inizio della puntata segnato alle ${ora(c.startMark)}.` : 'L\'inizio della puntata si segna da solo quando vai IN ONDA.'}</div>
          <div className="riga">
            <button onClick={() => esegui(api.segnaInizio(), setS)}>📍 Segna inizio</button>
            <button className="pericolo" onClick={() => esegui(api.fineProgramma(), setS)}>
              ⏹ Fine programma
            </button>
          </div>
          {c.problema && <div className="errore">{c.problema}</div>}
        </>
      ) : locale ? (
        <>
          <div>
            <span className="punto-rec" /> Registra solo sul computer dalle {loc?.inizio ? ora(loc.inizio) : ''} ({loc?.inizio ? durata(now - loc.inizio) : ''}, {mb(loc?.byte ?? 0)})
          </div>
          <div className="riga">
            <button className="pericolo" onClick={() => esegui(api.registraLocale(false), setLoc)}>
              ⏹ Ferma
            </button>
          </div>
          {loc?.problema && <div className="errore">{loc.problema}</div>}
        </>
      ) : (
        <>
          <div className="riga">
            <select value={scelta} onChange={(e) => setScelta(e.target.value)}>
              <option value="">Scegli il programma…</option>
              {programmi.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
            <button disabled={!scelta || stato?.collegamento !== 'collegato'} onClick={() => esegui(api.registra(scelta), setS)}>
              ⏺ Registra la puntata
            </button>
          </div>
          <div className="nota">
            Registra qui (MP3 320) e sul server. Se il collegamento non cade si tiene quella del server e la puntata si pubblica da sola;
            altrimenti parte il file del computer e la puntata va in "Puntate da rivedere".
          </div>
          <div className="riga">
            <button onClick={() => esegui(api.registraLocale(true), setLoc)}>💾 Registra solo sul computer</button>
            <button className="piccolo" onClick={() => void api.apriCartella()}>
              Apri la cartella
            </button>
          </div>
          {loc?.ultimo && <div className="nota">Ultima registrazione: {loc.ultimo}</div>}
        </>
      )}
      {s?.invii.map((x) => (
        <div key={x.file} className="nota">
          {x.title}: {x.stato === 'decidere' ? 'chiedo al server se ha la registrazione completa…' : `invio al server${x.inviatiByte ? ` (${mb(x.inviatiByte)})` : ''}…`}
          {x.errore && <span className="errore"> {x.errore} (riprovo tra poco)</span>}
        </div>
      ))}
      {errore && <div className="errore">{errore}</div>}
    </section>
  )
}

export function Diretta({
  imp,
  setImp,
  stato,
  motore,
  cambiaMixer
}: {
  imp: Impostazioni
  setImp: (i: Impostazioni) => void
  stato: StatoServer | null
  motore: Motore
  cambiaMixer: (m: ImpostazioniMixer) => void
}) {
  const [programmi, setProgrammi] = useState<Programma[]>([])
  const [testo, setTesto] = useState(imp.testo)
  const [errore, setErrore] = useState<string | null>(null)
  const [conferma, setConferma] = useState(false)
  const [now, setNow] = useState(Date.now())
  const collegato = stato?.collegamento === 'collegato'
  useEffect(() => {
    if (collegato) void api.programmi().then(setProgrammi).catch(() => {})
  }, [collegato])
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const e = stato?.esterna
  const inOnda = !!e?.inOnda
  const davvero = !!e?.inOndaDavvero
  const meta = (programId: string | null, t: string): void => {
    setImp({ ...imp, programId, testo: t })
    void api.meta(programId, t)
  }
  const onda = (on: boolean): void => {
    setErrore(null)
    setConferma(false)
    api.onda(on).catch((x: unknown) => setErrore(testoErrore(x)))
  }
  return (
    <div className="diretta">
      <section className={`riquadro onda ${davvero ? 'live' : inOnda ? 'attesa' : ''}`}>
        <div className="stato-onda">
          {davvero ? (
            <>
              <div className="grande">🔴 IN ONDA</div>
              <div>dalle {e?.since ? ora(Date.parse(e.since)) : ''} · {e?.since ? durata(now - Date.parse(e.since)) : ''}</div>
            </>
          ) : inOnda ? (
            <>
              <div className="grande">🟠 IN ONDA, ma il tuo audio non arriva</div>
              <div>La radio sente la regia finché il tuo audio non torna.</div>
            </>
          ) : (
            <>
              <div className="grande">FUORI ONDA</div>
              <div>{collegato ? 'Prova i livelli: la radio non ti sente ancora.' : 'Non sei collegato al server.'}</div>
            </>
          )}
        </div>
        {inOnda ? (
          conferma ? (
            <div className="riga">
              <button className="enorme fuori" onClick={() => onda(false)}>
                Sì, FUORI ONDA
              </button>
              <button onClick={() => setConferma(false)}>Annulla</button>
            </div>
          ) : (
            <button className="enorme fuori" onClick={() => setConferma(true)}>
              ⏹ FUORI ONDA
            </button>
          )
        ) : (
          <button className="enorme dentro" disabled={!collegato || !!(e && !e.audio && false)} onClick={() => onda(true)}>
            ▶ IN ONDA
          </button>
        )}
        {collegato && e && !e.audio && <div className="nota">Il server non riceve ancora il tuo audio: aspetta qualche secondo.</div>}
        {errore && <div className="errore">{errore}</div>}
      </section>

      <section className="riquadro titolo-onda">
        <h2>📝 Cosa vedono gli ascoltatori</h2>
        <div className="riga">
          <select value={imp.programId ?? ''} onChange={(x) => meta(x.target.value || null, testo)}>
            <option value="">Nessun programma</option>
            {programmi.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
          <input
            value={testo}
            placeholder="Riga libera, es. In diretta dalla Festa di Piazza Garibaldi"
            maxLength={200}
            onChange={(x) => setTesto(x.target.value)}
            onBlur={() => testo !== imp.testo && meta(imp.programId, testo)}
            onKeyDown={(x) => x.key === 'Enter' && meta(imp.programId, testo)}
          />
          <button onClick={() => meta(imp.programId, testo)} disabled={testo === imp.testo}>
            Aggiorna
          </button>
        </div>
        <div className="nota">
          Alla radio: <b>{e?.titolo ?? (testo || 'In diretta')}</b>. Quando il server riconosce un brano mostra titolo e artista finché dura, poi torna questo.
        </div>
      </section>

      <Mixer imp={imp} cambiaMixer={cambiaMixer} motore={motore} />
      <div className="due">
        <Cuffia imp={imp} cambiaMixer={cambiaMixer} stato={stato} motore={motore} />
        <Registrazione imp={imp} programmi={programmi} stato={stato} />
      </div>
    </div>
  )
}
