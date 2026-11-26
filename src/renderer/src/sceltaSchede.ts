// Scelta automatica delle schede audio alla prima accensione (regia a prova di anziano, 26/11/2026).

export interface Uscita {
  deviceId: string
  label: string
}

const RODECASTER = /r[oø]de\s*caster/i

/**
 * In onda: il RodeCaster (non il canale "Chat"), altrimenti l'uscita predefinita.
 * Preascolto: un'uscita diversa dal RodeCaster (le casse o le cuffie del PC), così quello che si
 * ascolta prima non finisce in onda. '' = predefinita di Windows.
 */
export function scegliUscite(uscite: Uscita[]): { onda: string; preascolto: string; rodecaster: boolean } {
  const rode = uscite.filter((u) => RODECASTER.test(u.label))
  const onda = rode.find((u) => !/chat/i.test(u.label)) ?? rode[0]
  const altre = uscite.filter((u) => !RODECASTER.test(u.label) && u.deviceId && u.deviceId !== 'communications')
  const pc = altre.find((u) => /cuffi|headphone|altoparlant|speaker|realtek/i.test(u.label)) ?? altre[0]
  if (!onda) return { onda: '', preascolto: pc?.deviceId ?? '', rodecaster: false }
  return { onda: onda.deviceId, preascolto: pc?.deviceId ?? '', rodecaster: true }
}
