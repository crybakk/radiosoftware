import { createReadStream, statSync } from 'node:fs'
import { extname } from 'node:path'
import { Readable } from 'node:stream'

const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg'
}

/** URL con cui il renderer chiede un file audio della libreria. */
export function mediaUrl(trackId: number): string {
  return `media://track/${trackId}`
}

/**
 * Risponde a una richiesta media:// servendo il file con supporto ai "Range",
 * necessario per spostarsi nel brano (punto di inizio) senza leggerlo tutto.
 */
export function serveFile(path: string, request: Request): Response {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return new Response('File non trovato', { status: 404 })
  }
  const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
  const range = request.headers.get('range')
  const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2])
    let end = m[1] && m[2] ? Number(m[2]) : size - 1
    start = Math.max(0, start)
    end = Math.min(size - 1, end)
    if (start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    }
    const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream
    return new Response(stream, {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes'
      }
    })
  }
  const stream = Readable.toWeb(createReadStream(path)) as ReadableStream
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' }
  })
}
