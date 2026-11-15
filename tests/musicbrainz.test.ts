import { describe, expect, it } from 'vitest'
import { lookupUrl, MusicBrainz, parseRecording, pickRecording, searchUrl, simplify } from '../src/core/musicbrainz'

const credit = (name: string) => [{ name, artist: { name } }]

describe('MusicBrainz', () => {
  it('confronta titoli e interpreti senza accenti e versioni tra parentesi', () => {
    expect(simplify('Perché (Remastered 2009)')).toBe('perche')
    expect(simplify('Jovanotti feat. Ospite')).toBe('jovanotti')
  })

  it('sceglie solo una registrazione sicura', () => {
    const t = { title: 'Albachiara', artist: 'Vasco Rossi', duration: 260 }
    const r = [
      { id: 'live', score: 100, title: 'Albachiara', length: 420_000, 'artist-credit': credit('Vasco Rossi') },
      { id: 'cover', score: 100, title: 'Albachiara', length: 259_000, 'artist-credit': credit('Altro') },
      { id: 'ok', score: 98, title: 'Albachiara (Remastered)', length: 258_000, 'artist-credit': credit('Vasco Rossi') },
      { id: 'basso', score: 60, title: 'Albachiara', length: 260_000, 'artist-credit': credit('Vasco Rossi') }
    ]
    expect(pickRecording(r, t)?.id).toBe('ok')
    expect(pickRecording(r.slice(0, 2), t)).toBeNull()
  })

  it('legge autori, editore, ISWC e ISRC dall\'opera collegata', () => {
    const res = parseRecording({
      id: 'rec',
      isrcs: ['ITA000000001', 'ITA000000002'],
      relations: [
        {
          type: 'performance',
          'target-type': 'work',
          work: {
            id: 'w',
            iswcs: ['T-000.000.001-0'],
            relations: [
              { type: 'composer', 'target-type': 'artist', artist: { name: 'Vasco Rossi' } },
              { type: 'lyricist', 'target-type': 'artist', artist: { name: 'Vasco Rossi' } },
              { type: 'lyricist', 'target-type': 'artist', artist: { name: 'Alberto Rossi' } },
              { type: 'arranger', 'target-type': 'artist', artist: { name: 'Arrangiatore' } },
              { type: 'publishing', 'target-type': 'label', label: { name: 'EMI Music Publishing' } }
            ]
          }
        }
      ]
    })
    expect(res).toEqual({
      recordingId: 'rec',
      composer: 'Vasco Rossi, Alberto Rossi',
      publisher: 'EMI Music Publishing',
      isrc: 'ITA000000001',
      iswc: 'T-000.000.001-0'
    })
  })

  it('una richiesta al secondo, nome del programma generico, riprova se occupato', async () => {
    let now = 0
    const waits: number[] = []
    const calls: { url: string; ua: string }[] = []
    const replies = [
      new Response('', { status: 503 }),
      Response.json({ recordings: [{ id: 'r1', score: 100, title: 'A "b"', length: 200_000, 'artist-credit': credit('X') }] }),
      Response.json({ id: 'r1', isrcs: ['IT1'], relations: [] })
    ]
    const mb = new MusicBrainz({
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms)
        now += ms
      },
      fetch: async (url, init) => {
        calls.push({ url, ua: (init.headers as Record<string, string>)['User-Agent'] })
        return replies.shift()!
      }
    })
    const r = await mb.find({ title: 'A "b"', artist: 'X', duration: 201 })
    expect(r).toMatchObject({ recordingId: 'r1', isrc: 'IT1' })
    expect(calls[0].url).toBe(searchUrl('A "b"', 'X'))
    expect(new URL(calls[0].url).searchParams.get('query')).toContain('recording:"A \\"b\\""')
    expect(calls[2].url).toBe(lookupUrl('r1'))
    expect(calls.every((c) => c.ua === 'RadioRegia/0.1')).toBe(true)
    expect(waits.filter((w) => w === 1100).length).toBeGreaterThanOrEqual(1)
    expect(waits).toContain(5000)
  })

  it('due ricerche insieme rispettano comunque una richiesta al secondo', async () => {
    // orologio che avanza solo con le attese
    let clock = 0
    const at: number[] = []
    const mb = new MusicBrainz({
      now: () => clock,
      sleep: async (ms) => {
        const target = clock + ms
        await new Promise((r) => setTimeout(r, 0))
        clock = Math.max(clock, target)
      },
      fetch: async () => {
        at.push(clock)
        return Response.json({ recordings: [] })
      }
    })
    await Promise.all(['A', 'B', 'C'].map((title) => mb.find({ title, artist: 'X', duration: 0 })))
    expect(at).toHaveLength(3)
    const sorted = [...at].sort((a, b) => a - b)
    for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(1000)
  })
})
