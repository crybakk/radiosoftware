/** Mezzanotte locale del giorno "AAAA-MM-GG"; null se la data è vuota o non valida (campo cancellato). */
export function dayStart(s: string): Date | null {
  const m = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

/** Intervallo [inizio di `from`, fine di `to`) in ISO; null se una delle due date non è valida. */
export function logRange(from: string, to: string): [string, string] | null {
  const start = dayStart(from)
  const end = dayStart(to)
  if (!start || !end) return null
  end.setDate(end.getDate() + 1)
  return [start.toISOString(), end.toISOString()]
}
