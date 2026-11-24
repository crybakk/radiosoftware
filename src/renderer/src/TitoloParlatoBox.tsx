// Titolo parlato (scelte di cristian, 24/11/2026): quando non suona nessun brano il ponte manda come titolo il
// programma e il conduttore; qui si vede cosa va in onda e si scrive un testo libero (es. "Ospite: Mario Rossi").
import { useEffect, useState } from 'react'
import type { SpokenTitleState } from '../../core/ponteClient'

const api = window.radio

export function TitoloParlatoBox() {
  const [s, setS] = useState<SpokenTitleState | null>(null)
  const [testo, setTesto] = useState('')
  const [modificato, setModificato] = useState(false)
  const [errore, setErrore] = useState<string | null>(null)

  useEffect(() => {
    const load = (): void => void api.ponteSpokenTitle().then(setS).catch(() => setS(null))
    load()
    const t = setInterval(load, 15_000)
    return () => clearInterval(t)
  }, [])
  // il testo scritto da un'altra parte (pannello) compare qui, se non si sta scrivendo
  useEffect(() => {
    if (s && !modificato) setTesto(s.testo)
  }, [s, modificato])

  if (!s) return null

  const salva = (v: string): void => {
    setErrore(null)
    api
      .ponteSetSpokenText(v)
      .then((r) => {
        setS(r)
        setTesto(r.testo)
        setModificato(false)
      })
      .catch((e: unknown) => setErrore(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)))
  }

  return (
    <div className="card titolo-parlato" data-sezione="titolo-parlato" data-titolo="Titolo quando si parla">
      <div className="section-title">
        Titolo quando si parla {s.inOnda && <span className="tp-onda">IN ONDA</span>}
      </div>
      <div className="tp-anteprima" title="Va in onda dopo 5 secondi senza brani">
        {s.artist ? `${s.artist} – ` : ''}
        {s.title}
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          salva(testo)
        }}
      >
        <input
          value={testo}
          maxLength={s.max}
          placeholder={s.programma ? 'Testo in più, es. Ospite: Mario Rossi' : 'Testo al posto dello slogan'}
          onChange={(e) => {
            setTesto(e.target.value)
            setModificato(true)
          }}
        />
        <button type="submit" disabled={!modificato}>
          Usa
        </button>
        {s.testo && (
          <button type="button" className="ghost" onClick={() => salva('')}>
            Togli
          </button>
        )}
      </form>
      <div className="hint">
        {s.programma ? `Il testo vale fino alla fine di "${s.programma}".` : 'Nessun programma in palinsesto adesso: va il nome della radio.'}
      </div>
      {errore && <div className="error-text">⚠️ {errore}</div>}
    </div>
  )
}
