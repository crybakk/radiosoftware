import type { LogEntry } from './types'

/** Campo CSV con separatore ";" (come lo vuole Excel in italiano). */
export function csvField(v: string | number | null | undefined): string {
  const s = v == null ? '' : String(v)
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Campo di testo del registro: se inizia con = + - @ (o tab/a capo) Excel lo leggerebbe come
 * formula, quindi davanti si mette un apostrofo. Non si usa per il CSV della SIAE, che resta com'è.
 */
export function csvText(v: string | number | null | undefined): string {
  const s = v == null ? '' : String(v)
  return csvField(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function formatDuration(seconds: number): string {
  const s = Math.round(seconds)
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
}

/** Registro di trasmissione completo, una riga per passaggio, orari locali. UTF-8 con BOM per Excel. */
export function logToCsv(entries: LogEntry[]): string {
  const header = [
    'DATA', 'ORA', 'DURATA', 'TIPO', 'TITOLO', 'ARTISTA', 'AUTORI', 'EDITORE', 'ISRC', 'ISWC', 'CODICE OPERA', 'FONTE'
  ]
  const rows = entries.map((e) => {
    const d = new Date(e.startedAt)
    return [
      `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`,
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
      formatDuration(e.playedSeconds),
      e.kind,
      e.title,
      e.artist,
      e.composer,
      e.publisher,
      e.isrc,
      e.iswc,
      e.siaeCode,
      e.source
    ]
      .map(csvText)
      .join(';')
  })
  return '﻿' + [header.join(';'), ...rows].join('\r\n') + '\r\n'
}
