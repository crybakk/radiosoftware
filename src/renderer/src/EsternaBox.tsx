// App Radio Esterna (dirette da fuori): in regia si vede chi è collegato, se è in onda, e la si ascolta in preascolto
// prima del passaggio (scelte di cristian, 24/11/2026). La regia non deve accettare: IN ONDA lo preme chi è fuori.
import { useState } from 'react'
import type { LineaStato } from '../../../ponte/controllo/src/protocol.ts'
import type { Radio } from './useRadio'

/** Id finto per il preascolto dell'esterna (i brani hanno id positivi). */
const ID_ESTERNA = -24

export function EsternaBox({ radio }: { radio: Radio }) {
  const e = radio.ponte?.esterna
  const [, force] = useState(0)
  const [errore, setErrore] = useState<string | null>(null)
  if (!e || (!e.collegata && !e.inOnda)) return null
  const ascolto = radio.preview.trackId === ID_ESTERNA && radio.preview.playing
  // frasi semplici (regia a prova di anziano, 27/11/2026)
  const stato = e.inOndaDavvero
    ? '🔴 In onda da fuori: la radio sente chi è fuori, non lo studio'
    : e.inOnda
      ? '🟠 Chi è fuori ha premuto IN ONDA, ma la sua voce non arriva: la radio manda ancora lo studio'
      : e.audio
        ? '📡 Collegato da fuori e pronto: non è ancora in onda'
        : '📡 Si sta collegando da fuori…'
  return (
    <div className={`esterna-box card ${e.inOndaDavvero ? 'live' : ''}`} data-sezione="esterna" data-titolo="Radio Esterna">
      <div className="esterna-head">
        <b>{stato}</b> {e.user && <span className="muted">· {e.user}</span>}
      </div>
      {e.titolo && <div className="esterna-titolo">{e.titolo}</div>}
      {e.collegata && e.linea && <LineaBadge linea={e.linea} via={e.via ?? null} avanzate={!!radio.settings.mostraAvanzate} />}
      <div className="row">
        <button
          className={`small ${ascolto ? 'on' : ''}`}
          disabled={!e.ascoltoUrl}
          title="Lo senti solo tu, nelle cuffie del preascolto: non va alla radio"
          onClick={async () => {
            setErrore(null)
            if (ascolto) radio.preview.stop()
            else if (e.ascoltoUrl) await radio.preview.play(e.ascoltoUrl, ID_ESTERNA).catch(() => setErrore("L'audio dell'esterna non arriva ancora: riprova tra poco."))
            force((n) => n + 1)
          }}
        >
          {ascolto ? '■ Smetti di ascoltare' : '🎧 Ascolta chi è fuori (solo tu)'}
        </button>
      </div>
      {errore && <div className="esterna-errore">{errore}</div>}
    </div>
  )
}

const PALLINI = { buona: '🟢', debole: '🟡', pessima: '🔴', assente: '⚫' } as const

/** Qualità della linea di chi è fuori (26/11/2026): pallino e frase; i numeri solo passando sopra con il mouse. */
function LineaBadge({ linea, via, avanzate }: { linea: LineaStato; via: 'webrtc' | 'https' | null; avanzate: boolean }) {
  const dettagli = [
    linea.perdita ? `pacchetti persi o in ritardo ${linea.perdita}%` : '',
    linea.buchi ? `audio ricostruito ${linea.buchi}%` : '',
    linea.ritardo ? `ritardo della linea ${linea.ritardo} ms` : '',
    via === 'webrtc' ? 'collegamento WebRTC (UDP)' : via === 'https' ? 'collegamento di riserva (HTTPS)' : ''
  ].filter(Boolean)
  return (
    <div className={`linea ${linea.livello}`} title={`Dettagli: ${dettagli.join(' · ') || 'nessun problema'}`}>
      {PALLINI[linea.livello]} {linea.frase}
      {avanzate && dettagli.length > 0 && <div className="muted">{dettagli.join(' · ')}</div>}
    </div>
  )
}
