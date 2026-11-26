import { useEffect, useState } from 'react'
import type { Canale, Impostazioni, ImpostazioniMixer, Programma, StatoRegistrazioneLocale, StatoRegistrazioneProgrammi, StatoServer, LineaStato } from '../../shared/api'
import { DB_MAX, DB_MIN, MAX_CANALI, nuovoCanale } from '../../shared/mixer'
import { dispositivi, type Motore } from './motore'
import { testoErrore } from './App'
import { ConfermaBottone } from './Conferma'

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

function Fader({ db, onChange, avanzate, normale = 0 }: { db: number; onChange: (db: number) => void; avanzate: boolean; normale?: number }) {
  return (
    <div className="fader">
      <span className="etichetta">Volume</span>
      <input type="range" min={DB_MIN} max={DB_MAX} step={0.5} value={db} onChange={(e) => onChange(Number(e.target.value))} onDoubleClick={() => onChange(normale)} title="Doppio clic: volume normale" />
      {avanzate ? (
        <span className="db">{db <= DB_MIN ? '−∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`}</span>
      ) : (
        db !== normale && (
          <button className="piccolo" onClick={() => onChange(normale)} title="Rimette il volume normale">
            Normale
          </button>
        )
      )}
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
  const avanzate = imp.mostraAvanzate
  return (
    <section className="riquadro mixer">
      <h2>🎚 Microfoni e audio</h2>
      <div className="nota">Parla nel microfono: la barra colorata si deve muovere. Se resta ferma, scegli un altro microfono qui sotto.</div>
      <div className="strisce">
        {m.canali.map((c) => (
          <div key={c.id} className={`striscia ${c.muto ? 'muta' : ''}`}>
            <div className="riga">
              <input className="nome" value={c.nome} onChange={(e) => canale(c, { nome: e.target.value })} />
              <button className={`muto ${c.muto ? 'acceso' : ''}`} onClick={() => canale(c, { muto: !c.muto })} title={c.muto ? 'Premi per riaccendere il microfono' : 'Premi per spegnere il microfono'}>
                {c.muto ? '🔇 Spento: premi per accendere' : '🎙 Acceso'}
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
              {(avanzate || c.parte !== 'stereo') && (
                <select value={c.parte} onChange={(e) => canale(c, { parte: e.target.value as Canale['parte'] })} title="Quale ingresso della scheda audio">
                  <option value="stereo">Tutti e due gli ingressi</option>
                  <option value="sinistro">Solo ingresso 1</option>
                  <option value="destro">Solo ingresso 2</option>
                </select>
              )}
            </div>
            <Livello valore={l.canali.get(c.id) ?? 0} />
            <Fader db={c.volumeDb} onChange={(db) => canale(c, { volumeDb: db })} avanzate={avanzate} />
            {motore.errori.get(c.id) && <div className="errore">{motore.errori.get(c.id)}</div>}
            {m.canali.length > 1 && (
              <ConfermaBottone
                className="piccolo togli"
                domanda={`Togliere "${c.nome}"?`}
                si="Sì, togli"
                onSi={() => cambiaMixer({ ...m, canali: m.canali.filter((x) => x.id !== c.id) })}
              >
                Togli questo microfono
              </ConfermaBottone>
            )}
          </div>
        ))}
        <div className={`striscia pc ${!m.pc.attivo ? 'spenta' : m.pc.muto ? 'muta' : ''}`}>
          <div className="riga">
            <b className="nome">💻 Audio del computer</b>
            <label className="interruttore">
              <input type="checkbox" checked={m.pc.attivo} onChange={(e) => cambiaMixer({ ...m, pc: { ...m.pc, attivo: e.target.checked } })} /> Manda in onda
            </label>
          </div>
          {m.pc.attivo && (
            <>
              <div className="riga">
                <button className={`muto ${m.pc.muto ? 'acceso' : ''}`} onClick={() => cambiaMixer({ ...m, pc: { ...m.pc, muto: !m.pc.muto } })}>
                  {m.pc.muto ? '🔇 Spento: premi per accendere' : '🔊 Acceso'}
                </button>
                {avanzate && (
                  <label className="interruttore" title="Di solito no: l'audio del computer lo senti già dalle casse o dalle cuffie del computer">
                    <input type="checkbox" checked={m.pc.inCuffia} onChange={(e) => cambiaMixer({ ...m, pc: { ...m.pc, inCuffia: e.target.checked } })} /> Anche in cuffia
                  </label>
                )}
              </div>
              <Livello valore={l.pc} />
              <Fader db={m.pc.volumeDb} onChange={(db) => cambiaMixer({ ...m, pc: { ...m.pc, volumeDb: db } })} avanzate={avanzate} normale={-6} />
            </>
          )}
          <small>Per mandare in onda quello che suona sul computer (una musica, un video). Usa per la cuffia un'uscita diversa da quella del computer, se no va in onda anche quello che senti in cuffia.</small>
          {motore.errori.get('pc') && <div className="errore">{motore.errori.get('pc')}</div>}
        </div>
      </div>
      <div className="riga uscita">
        {m.canali.length < MAX_CANALI && (
          <button onClick={() => cambiaMixer({ ...m, canali: [...m.canali, nuovoCanale(m.canali.length + 1)] })}>+ Aggiungi un microfono</button>
        )}
        <span className="etichetta">Quello che va alla radio</span>
        <Livello valore={l.uscita} />
        {avanzate ? (
          <span className={`limitatore ${l.riduzione < -3 ? 'attivo' : ''}`} title="Il limitatore abbassa i picchi perché non distorca">
            Limitatore {l.riduzione < -0.5 ? `${l.riduzione.toFixed(0)} dB` : ''}
          </span>
        ) : (
          l.riduzione < -6 && <span className="limitatore attivo">Troppo forte: abbassa un po' il volume</span>
        )}
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
        Dove è attaccata la cuffia
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
        Volume della tua voce in cuffia
        <input type="range" min={0} max={1} step={0.01} value={m.cuffiaVolume} onChange={(e) => cambiaMixer({ ...m, cuffiaVolume: Number(e.target.value) })} />
      </label>
      <label className="interruttore">
        <input type="checkbox" checked={m.ritorno} onChange={(e) => cambiaMixer({ ...m, ritorno: e.target.checked })} /> Senti lo studio in cuffia
        {m.ritorno && (
          <span className="nota">
            {!stato?.regia && !motore.ritornoVeloce() ? ' (lo studio è spento)' : motore.ritornoInAscolto() ? ' (lo senti)' : ' (sta arrivando…)'}
          </span>
        )}
      </label>
      {m.ritorno && (
        <label>
          Volume dello studio in cuffia
          <input type="range" min={0} max={1} step={0.01} value={m.ritornoVolume} onChange={(e) => cambiaMixer({ ...m, ritornoVolume: Number(e.target.value) })} />
        </label>
      )}
      <small>
        In cuffia senti lo studio e chi parla dal pannello, così potete parlarvi. Non ascoltare la radio in cuffia: arriva in ritardo e confonde.
      </small>
    </section>
  )
}

function Registrazione({ imp, programmi, stato }: { imp: Impostazioni; programmi: Programma[]; stato: StatoServer | null }) {
  const avanzate = imp.mostraAvanzate
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
            <span className="punto-rec" /> Sto registrando <b>{c.title}</b> dalle {ora(c.startedAt)} ({durata(now - c.startedAt)}{avanzate ? `, ${mb(c.bytes)}` : ''})
          </div>
          <div className="nota">{c.startMark ? `La puntata comincia alle ${ora(c.startMark)}.` : 'La puntata comincia da sola quando premi IN ONDA.'}</div>
          <div className="riga">
            {avanzate && <button onClick={() => esegui(api.segnaInizio(), setS)}>📍 Segna inizio</button>}
            <ConfermaBottone className="pericolo" domanda="Il programma è finito? La registrazione si ferma." si="Sì, è finito" onSi={() => esegui(api.fineProgramma(), setS)}>
              ⏹ Programma finito
            </ConfermaBottone>
          </div>
          {c.problema && <div className="errore">{c.problema}</div>}
        </>
      ) : locale ? (
        <>
          <div>
            <span className="punto-rec" /> Sto registrando sul computer dalle {loc?.inizio ? ora(loc.inizio) : ''} ({loc?.inizio ? durata(now - loc.inizio) : ''}{avanzate ? `, ${mb(loc?.byte ?? 0)}` : ''})
          </div>
          <div className="riga">
            <ConfermaBottone className="pericolo" domanda="Fermare la registrazione?" si="Sì, ferma" onSi={() => esegui(api.registraLocale(false), setLoc)}>
              ⏹ Ferma la registrazione
            </ConfermaBottone>
          </div>
          {loc?.problema && <div className="errore">{loc.problema}</div>}
        </>
      ) : (
        <>
          <div className="riga">
            <select value={scelta} onChange={(e) => setScelta(e.target.value)}>
              <option value="">Quale programma fai?</option>
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
            La puntata si salva sulla radio e, per sicurezza, anche su questo computer. Quando hai finito premi "Programma finito": la puntata si
            pubblica da sola (se il collegamento è caduto, la trovi in "Puntate da rivedere" nel pannello).
          </div>
          <div className="riga">
            <button onClick={() => esegui(api.registraLocale(true), setLoc)} title="Un file sul computer, senza puntata sulla radio">💾 Registra solo sul computer</button>
            <button className="piccolo" onClick={() => void api.apriCartella()}>
              Apri la cartella
            </button>
          </div>
          {loc?.ultimo && <div className="nota">Ultima registrazione: {loc.ultimo}</div>}
        </>
      )}
      {s?.invii.map((x) => (
        <div key={x.file} className="nota">
          {x.title}: {x.stato === 'decidere' ? 'controllo se la radio ha la registrazione completa…' : `mando la registrazione alla radio${x.inviatiByte && avanzate ? ` (${mb(x.inviatiByte)})` : ''}…`}
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
              <div>La radio manda lo studio finché la tua voce non torna. Controlla internet.</div>
            </>
          ) : (
            <>
              <div className="grande">FUORI ONDA</div>
              <div>{collegato ? 'La radio non ti sente ancora. Prova il microfono qui sotto, poi premi IN ONDA.' : 'Aspetta il collegamento alla radio (in alto).'}</div>
            </>
          )}
        </div>
        {inOnda ? (
          conferma ? (
            <div className="riga">
              <span className="domanda">Hai finito? La radio torna allo studio.</span>
              <button className="enorme fuori" onClick={() => onda(false)}>
                Sì, FUORI ONDA
              </button>
              <button onClick={() => setConferma(false)}>No, resto in onda</button>
            </div>
          ) : (
            <button className="enorme fuori" onClick={() => setConferma(true)}>
              ⏹ FUORI ONDA
            </button>
          )
        ) : (
          <button className="enorme dentro" disabled={!collegato} onClick={() => onda(true)} title="Vai in onda al posto dello studio">
            ▶ IN ONDA
          </button>
        )}
        {collegato && e && !e.audio && <div className="nota">La radio non riceve ancora la tua voce: aspetta qualche secondo.</div>}
        {collegato && e?.linea && <Linea linea={e.linea} via={e.via ?? null} avanzate={imp.mostraAvanzate} />}
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
            Cambia il titolo
          </button>
        </div>
        <div className="nota">
          Gli ascoltatori leggono: <b>{e?.titolo ?? (testo || 'In diretta')}</b>. Se fai sentire una canzone, la radio la riconosce e mostra il suo titolo finché dura.
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

const PALLINI = { buona: '🟢', debole: '🟡', pessima: '🔴', assente: '⚫' } as const

/** Qualità della tua linea, misurata dal server (26/11/2026): pallino e frase; i numeri passando sopra col mouse. */
function Linea({ linea, via, avanzate }: { linea: LineaStato; via: 'webrtc' | 'https' | null; avanzate: boolean }) {
  const dettagli = [
    linea.perdita ? `pacchetti persi o in ritardo ${linea.perdita}%` : '',
    linea.buchi ? `audio ricostruito ${linea.buchi}%` : '',
    linea.ritardo ? `ritardo della linea ${linea.ritardo} ms` : '',
    via === 'webrtc' ? 'collegamento veloce (WebRTC)' : via === 'https' ? 'collegamento di riserva (HTTPS)' : ''
  ].filter(Boolean)
  return (
    <div className={`linea ${linea.livello}`} title={`Dettagli: ${dettagli.join(' · ') || 'nessun problema'}`}>
      {PALLINI[linea.livello]} {linea.frase}
      {(linea.livello === 'pessima' || linea.livello === 'debole') && (
        <div className="nota">Se puoi, avvicinati al router o usa il cavo di rete, e chiudi i programmi che usano internet.</div>
      )}
      {avanzate && dettagli.length > 0 && <div className="nota">{dettagli.join(' · ')}</div>}
    </div>
  )
}
