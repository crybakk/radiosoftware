import { useState, type ReactNode } from 'react'

/**
 * Pulsante che chiede conferma prima di un'azione che non si può annullare (come la regia, 26/11/2026):
 * al primo clic compare la domanda con "Sì" e "No".
 */
export function ConfermaBottone({
  domanda,
  si,
  onSi,
  className,
  disabled,
  children
}: {
  domanda: string
  si: string
  onSi: () => void
  className?: string
  disabled?: boolean
  children: ReactNode
}) {
  const [chiede, setChiede] = useState(false)
  if (!chiede)
    return (
      <button className={className} disabled={disabled} onClick={() => setChiede(true)}>
        {children}
      </button>
    )
  return (
    <span className="conferma">
      <span className="domanda">{domanda}</span>
      <button
        className="pericolo"
        onClick={() => {
          setChiede(false)
          onSi()
        }}
      >
        {si}
      </button>
      <button onClick={() => setChiede(false)}>No</button>
    </span>
  )
}
