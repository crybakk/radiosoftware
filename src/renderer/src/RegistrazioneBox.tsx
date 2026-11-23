// Registrazione dei programmi fatti dallo studio (scelte di cristian, 23/11/2026): tasti e avvisi in regia.
import { useEffect, useState } from 'react'
import type { StatoRegistrazioneProgrammi } from '../../core/registrazioneProgrammi'

const api = window.radio

function ora(ms: number): string {
  return new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
}

function durata(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}`
}

const mb = (b: number): string => `${(b / 1024 / 1024).toLocaleString('it-IT', { maximumFractionDigits: 0 })} MB`

export function RegistrazioneBox() {
  const [s, setS] = useState<StatoRegistrazioneProgrammi | null>(null)
  const [now, setNow] = useState(Date.now())
  const [scelta, setScelta] = useState('')
  const [errore, setErrore] = useState<string | null>(null)

  useEffect(() => {
    void api.registrazioneStato().then(setS).catch(() => {})
    const off = api.onRegistrazioneStato(setS)
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [])

  const esegui = (p: Promise<StatoRegistrazioneProgrammi>) => {
    setErrore(null)
    p.then(setS).catch((e: unknown) => setErrore(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)))
  }

  if (!s) return null
  const c = s.corrente
  const f = s.fascia
  const invii = s.invii

  return (
    <div className={`registrazione card ${c ? 'rec' : s.fase === 'pronta' ? 'pronta' : ''}`} data-sezione="registrazione" data-titolo="Registrazione del programma">
      {c ? (
        <>
          <div className="reg-head">
            <span className="reg-dot" /> REC <strong>{c.title}</strong> · {durata(now - c.startedAt)} · {mb(c.bytes)}
          </div>
          {c.startMark && <div className="hint">📍 Inizio programma segnato alle {ora(c.startMark)}</div>}
          {s.fase === 'avviso-fine' && c.stopAt && (
            <div className="reg-avviso">
              ⏰ La fascia sta finendo: la registrazione si ferma da sola alle {ora(c.stopAt)} (tra {durata(c.stopAt - now)}).
            </div>
          )}
          {c.stopAt && s.fase !== 'avviso-fine' && <div className="hint">Si ferma da sola alle {ora(c.stopAt)}.</div>}
          {!c.stopAt && <div className="hint">Non si ferma da sola: premi "Fine programma" quando hai finito.</div>}
          {c.problema && <div className="error-text">⚠️ {c.problema}</div>}
          {c.bytes === 0 && now - c.startedAt > 10_000 && <div className="error-text">⚠️ Non arriva audio: controlla che l'invio al ponte sia acceso.</div>}
          <div className="row">
            <button title="Segna qui l'inizio vero del programma (per il taglio della puntata)" onClick={() => esegui(api.registrazioneRegistra())}>
              📍 Segna inizio programma
            </button>
            {s.fase === 'avviso-fine' && (
              <button className="primary" title="La registrazione continua finché non premi Fine programma" onClick={() => esegui(api.registrazioneNonFermare())}>
                Non fermare
              </button>
            )}
            <button className="danger" title="Ferma la registrazione e segna la fine del programma" onClick={() => esegui(api.registrazioneFine())}>
              ⏹ Fine programma
            </button>
          </div>
        </>
      ) : s.fase === 'pronta' && f ? (
        <>
          <div className="reg-head">
            🎙 <strong>{f.title}</strong> alle {ora(f.start)}
            {f.start > now ? ` (tra ${durata(f.start - now)})` : ''}
          </div>
          <div className="hint">Se non premi, la registrazione parte da sola all'orario.</div>
          <div className="row">
            <button className="primary" onClick={() => esegui(api.registrazioneRegistra(f.programId))}>
              ⏺ Registra adesso
            </button>
          </div>
        </>
      ) : (
        <div className="row reg-manuale">
          <span className="hint">Registrazione programma</span>
          {s.programmi.length ? (
            <>
              <select value={scelta} onChange={(e) => setScelta(e.target.value)} title="Programma da registrare">
                <option value="">Scegli il programma…</option>
                {s.programmi.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
              <button disabled={!scelta} onClick={() => esegui(api.registrazioneRegistra(scelta))}>
                ⏺ Registra
              </button>
            </>
          ) : (
            <span className="hint">nessun programma "Va in onda dallo studio" nel pannello</span>
          )}
        </div>
      )}
      {errore && <div className="error-text">{errore}</div>}
      {invii.map((x) => (
        <div key={x.file} className="hint">
          {x.stato === 'decidere' ? '⏳ ' : '⬆ '}
          {x.title} del {new Date(x.startedAt).toLocaleDateString('it-IT')}:{' '}
          {x.stato === 'decidere'
            ? 'chiedo al ponte se ha la registrazione completa'
            : x.inviatiByte !== undefined
            ? `invio al server, ${mb(x.inviatiByte)}`
            : 'da inviare al server'}
          {x.errore ? ` (riprovo tra poco: ${x.errore})` : ''}
        </div>
      ))}
    </div>
  )
}
