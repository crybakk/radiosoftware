// Ordine delle sezioni scelto da chi usa la regia (richiesta di cristian, 19/11/2026).
// Funzioni pure, provate in tests/ordine.test.ts. Lo stesso algoritmo è in ponte/controllo/pannello/ordine.js.

/**
 * Unisce l'ordine salvato con le sezioni che esistono adesso.
 * Le sezioni salvate restano tutte (anche quelle che ora non si vedono, così non perdono il posto);
 * una sezione nuova, mai riordinata, va subito dopo quella che la precede nell'ordine predefinito.
 */
export function unisciOrdine(predefinito: readonly string[], salvato: readonly string[] | null | undefined): string[] {
  const out: string[] = []
  for (const id of Array.isArray(salvato) ? salvato : []) if (typeof id === 'string' && !out.includes(id)) out.push(id)
  predefinito.forEach((id, i) => {
    if (out.includes(id)) return
    let pos = 0
    for (let j = i - 1; j >= 0; j--) {
      const k = out.indexOf(predefinito[j])
      if (k >= 0) {
        pos = k + 1
        break
      }
    }
    out.splice(pos, 0, id)
  })
  return out
}

/**
 * Sposta una sezione di un posto prima (-1) o dopo (+1), saltando le sezioni che ora non si vedono.
 * Restituisce l'ordine completo (da salvare); se non si può spostare lo restituisce uguale.
 */
export function spostaSezione(ordine: readonly string[], visibili: readonly string[], id: string, verso: -1 | 1): string[] {
  const vis = ordine.filter((x) => visibili.includes(x))
  const i = vis.indexOf(id)
  const altro = vis[i + verso]
  if (i < 0 || altro === undefined) return [...ordine]
  const out = [...ordine]
  const a = out.indexOf(id)
  const b = out.indexOf(altro)
  out[a] = altro
  out[b] = id
  return out
}

const PREFISSO = 'regia.ordine.'

export function leggiOrdine(chiave: string): string[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(PREFISSO + chiave) ?? 'null')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : null
  } catch {
    return null
  }
}

export function salvaOrdine(chiave: string, ordine: string[] | null): void {
  try {
    if (ordine) localStorage.setItem(PREFISSO + chiave, JSON.stringify(ordine))
    else localStorage.removeItem(PREFISSO + chiave)
  } catch {
    /* spazio pieno o storage non disponibile: l'ordine vale fino alla chiusura */
  }
  window.dispatchEvent(new CustomEvent('regia-ordine', { detail: chiave }))
}
