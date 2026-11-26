// Finestra "Sei sicuro?" grande e chiara (regia a prova di anziano, 26/11/2026): per i pulsanti che
// possono lasciare la radio muta o togliere qualcosa. Il pulsante sicuro ("No, lascia stare") è quello
// in evidenza, così un tocco distratto non fa danni.
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

export interface RichiestaConferma {
  titolo: string
  testo?: string
  /** Testo del pulsante che fa l'azione, es. "Sì, ferma la musica". */
  si: string
  no?: string
}

type Chiedi = (r: RichiestaConferma) => Promise<boolean>

const ConfermaContext = createContext<Chiedi>(async () => true)

/** Chiede conferma; risponde true solo se si preme il pulsante "sì". */
export const useConferma = (): Chiedi => useContext(ConfermaContext)

export function ConfermaProvider({ children }: { children: ReactNode }) {
  const [aperta, setAperta] = useState<(RichiestaConferma & { fine: (ok: boolean) => void }) | null>(null)
  const chiedi = useCallback<Chiedi>(
    (r) =>
      new Promise<boolean>((resolve) =>
        setAperta({
          ...r,
          fine: (ok) => {
            setAperta(null)
            resolve(ok)
          }
        })
      ),
    []
  )
  return (
    <ConfermaContext.Provider value={chiedi}>
      {children}
      {aperta && (
        <div className="modal conferma" onClick={() => aperta.fine(false)}>
          <div className="modal-body conferma-body" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="conferma-titolo">{aperta.titolo}</div>
            {aperta.testo && <p className="conferma-testo">{aperta.testo}</p>}
            <div className="conferma-pulsanti">
              <button className="primary big-ish" autoFocus onClick={() => aperta.fine(false)}>
                {aperta.no ?? 'No, lascia stare'}
              </button>
              <button className="danger big-ish" onClick={() => aperta.fine(true)}>
                {aperta.si}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfermaContext.Provider>
  )
}
