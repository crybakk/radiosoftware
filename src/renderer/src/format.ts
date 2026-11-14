export function mmss(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const s = Math.floor(seconds)
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

export function hhmm(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
}

export function hhmmss(d: Date): string {
  return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export const KIND_LABEL: Record<string, string> = {
  music: 'Musica',
  jingle: 'Jingle',
  news: 'Notiziario',
  program: 'Programma',
  spot: 'Spot'
}
