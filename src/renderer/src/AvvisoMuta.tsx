// Avviso grande quando la musica sta per finire e nessuno ha messo altro in coda (regia a prova di anziano,
// 26/11/2026). Succede solo in MANUALE: in AUTOMATICO la coda si riempie da sola.
import { useEffect, useState } from 'react'
import type { Radio } from './useRadio'

/** Secondi prima della fine in cui compare l'avviso. */
export const SECONDI_AVVISO = 30
/** Regia ferma da almeno tanti secondi prima di avvisare (evita lampeggi tra un brano e l'altro). */
const SECONDI_FERMA = 5

export type StatoMuta = { tipo: 'finisce'; secondi: number } | { tipo: 'ferma' } | null

/** Cosa dire, dato lo stato del motore. Pura: provata nei test. */
export function statoMuta(p: {
  mode: 'auto' | 'manual'
  remaining: number | null
  queue: number
  fermaDaSecondi: number
}): StatoMuta {
  if (p.mode !== 'manual' || p.queue > 0) return null
  if (p.remaining === null) return p.fermaDaSecondi >= SECONDI_FERMA ? { tipo: 'ferma' } : null
  return p.remaining <= SECONDI_AVVISO ? { tipo: 'finisce', secondi: Math.max(0, Math.ceil(p.remaining)) } : null
}

export function AvvisoMuta({ radio }: { radio: Radio }) {
  const s = radio.snapshot
  const main = s.onAir.at(-1)
  const [fermaDa, setFermaDa] = useState<number | null>(null)
  const [, tick] = useState(0)
  useEffect(() => {
    if (main) setFermaDa(null)
    else setFermaDa((v) => v ?? Date.now())
  }, [!!main]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (main) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [!!main]) // eslint-disable-line react-hooks/exhaustive-deps

  // con l'ingresso del RodeCaster in onda (microfoni) la regia ferma non vuol dire silenzio: si avvisa solo
  // quando la musica sta per finire
  const soloProgramma = radio.settings.ponte.source !== 'ingresso'
  const st = statoMuta({
    mode: s.mode,
    remaining: main ? main.remaining : null,
    queue: s.queue.length,
    fermaDaSecondi: fermaDa ? (Date.now() - fermaDa) / 1000 : 0
  })
  if (!st || (st.tipo === 'ferma' && !soloProgramma)) return null
  return (
    <div className={`banner avviso-muta ${st.tipo === 'finisce' ? 'error' : 'warn'}`}>
      <span>
        {st.tipo === 'finisce'
          ? `⚠ Tra ${st.secondi} secondi la musica finisce e non c'è niente in coda.`
          : '⚠ La regia è ferma: non sta mandando musica in onda.'}{' '}
        Aggiungi un brano alla coda oppure
      </span>
      <button className="primary big-ish" onClick={() => radio.engine.setMode('auto')}>
        Passa ad AUTOMATICO
      </button>
    </div>
  )
}
