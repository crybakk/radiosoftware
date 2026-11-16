import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { analyzeFile, computeCuePoints, parseEbur128 } from '../src/core/analyzer'
import { RadioDb } from '../src/core/db'
import { guessFromFilename, scanLibrary } from '../src/core/scanner'

const ffmpeg = 'ffmpeg'
let hasFfmpeg = true
try {
  execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' })
} catch {
  hasFfmpeg = false
}

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'radio-test-'))
  mkdirSync(join(dir, 'musica'))
  mkdirSync(join(dir, 'jingle'))
  if (!hasFfmpeg) return
  // 1,5 s di silenzio + 6 s di tono con sfumatura finale + 2 s di silenzio, con tag ID3
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=1.5',
    '-f', 'lavfi', '-i', 'sine=f=440:d=6:r=44100',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=2',
    '-filter_complex', '[1]aformat=channel_layouts=stereo,afade=t=out:st=4:d=2[s];[0][s][2]concat=n=3:v=0:a=1',
    '-metadata', 'title=Canzone di prova', '-metadata', 'artist=Artista Prova', '-metadata', 'composer=Autore Uno',
    '-metadata', 'TSRC=ITABC2600001', '-metadata', 'publisher=Edizioni Prova',
    '-b:a', '192k', join(dir, 'musica', 'prova.mp3')
  ])
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=880:d=2:r=44100',
    '-b:a', '128k', join(dir, 'jingle', '01 - Radio - Sigla breve.mp3')
  ])
  writeFileSync(join(dir, 'musica', 'note.txt'), 'non audio')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('analisi', () => {
  it('legge le misure di ffmpeg', () => {
    const out = `[Parsed_ebur128_0 @ 0x1] t: 0.1  TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU
[Parsed_ebur128_0 @ 0x1] t: 0.2  TARGET:-23 LUFS    M: -20.0 S:-120.7     I: -20.0 LUFS       LRA:   0.0 LU
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -14.3 LUFS`
    const r = parseEbur128(out)
    expect(r.frames).toEqual([{ t: 0.1, m: -120.7 }, { t: 0.2, m: -20 }])
    expect(r.integrated).toBe(-14.3)
  })

  it('il punto di mix non si sovrappone più di 10 s', () => {
    const frames = Array.from({ length: 300 }, (_, i) => ({ t: (i + 1) * 0.1, m: i < 290 ? (i < 50 ? -15 : -40) : -100 }))
    const r = computeCuePoints(frames, -15, 30)
    expect(r.cueOut).toBeCloseTo(29, 1)
    expect(r.mixPoint).toBeCloseTo(19, 1)
  })

  it.skipIf(!hasFfmpeg)('trova silenzi iniziali, finali e loudness su un file vero', async () => {
    const r = await analyzeFile(ffmpeg, join(dir, 'musica', 'prova.mp3'))
    expect(r.duration).toBeGreaterThan(9)
    expect(r.loudness).toBeLessThan(-15)
    expect(r.loudness).toBeGreaterThan(-30)
    expect(r.cueIn).toBeGreaterThan(1.0)
    expect(r.cueIn).toBeLessThan(1.6)
    expect(r.cueOut).toBeGreaterThan(7)
    expect(r.cueOut).toBeLessThan(8)
    expect(r.mixPoint).toBeGreaterThan(5)
    expect(r.mixPoint).toBeLessThanOrEqual(r.cueOut)
  })
})

describe('libreria', () => {
  it('ricava artista e titolo dal nome del file', () => {
    expect(guessFromFilename('C:\\x\\03 - Vasco Rossi - Albachiara.mp3')).toEqual({ artist: 'Vasco Rossi', title: 'Albachiara' })
    expect(guessFromFilename('/x/Albachiara.mp3')).toEqual({ artist: '', title: 'Albachiara' })
  })

  it.skipIf(!hasFfmpeg)('scansiona cartelle, legge i tag e salta i file invariati', async () => {
    const db = new RadioDb(':memory:')
    db.addFolder(join(dir, 'musica'), 'music')
    db.addFolder(join(dir, 'jingle'), 'jingle')
    const first = await scanLibrary(db)
    expect(first.added).toBe(2)
    const { tracks } = db.searchTracks({ text: 'prova' })
    expect(tracks).toHaveLength(1)
    // una ricerca enorme si taglia (200 caratteri, 8 parole) invece di bloccare la regia
    const t0 = Date.now()
    expect(db.searchTracks({ text: 'prova '.repeat(2000) }).tracks).toHaveLength(1)
    expect(Date.now() - t0).toBeLessThan(500)
    const t = tracks[0]
    expect(t.title).toBe('Canzone di prova')
    expect(t.artist).toBe('Artista Prova')
    expect(t.composer).toBe('Autore Uno')
    expect(t.isrc).toBe('ITABC2600001')
    expect(t.publisher).toBe('Edizioni Prova')
    expect(t.bitrate).toBe(192)
    const jingle = db.searchTracks({ kind: 'jingle' }).tracks[0]
    expect(jingle.title).toBe('Sigla breve')
    expect(jingle.artist).toBe('Radio')

    const second = await scanLibrary(db)
    expect(second.added + second.updated).toBe(0)

    rmSync(join(dir, 'jingle', '01 - Radio - Sigla breve.mp3'))
    const third = await scanLibrary(db)
    expect(third.disabled).toBe(1)
    expect(db.libraryStats().total).toBe(1)
    db.close()
  })
})

describe('database', () => {
  it('salva impostazioni, eventi e registro', () => {
    const db = new RadioDb(':memory:')
    expect(db.getSettings().crossfadeSeconds).toBe(3)
    db.saveSettings({ crossfadeSeconds: 5, cartwall: [1] as (number | null)[] })
    expect(db.getSettings().crossfadeSeconds).toBe(5)
    expect(db.getSettings().cartwall).toHaveLength(12)

    const id = db.upsertScanned({
      path: '/a.mp3', kind: 'music', size: 1, mtime: 1, title: 'A', artist: 'B', album: '', year: 2001, genre: '',
      composer: 'C', publisher: '', isrc: '', duration: 100, bitrate: 320, sampleRate: 44100
    })
    db.updateTrack(id, { siaeCode: '00123', enabled: true })
    expect(db.getTrack(id)!.siaeCode).toBe('00123')
    // chiavi strane da un messaggio IPC: ignorate, non finiscono nella query
    db.updateTrack(id, JSON.parse('{"constructor":"x","toString":"y","title":"A"}'))
    expect(db.getTrack(id)!.title).toBe('A')
    const base = {
      label: 'Sigla', time: '08:00', days: [1, 2], repeatMinutes: 0, untilTime: null, validFrom: null, validTo: null,
      mode: 'hard' as const, toleranceSeconds: 0, actions: [{ type: 'play' as const, trackId: id }], enabled: true
    }
    expect(() => db.saveEvent({ ...base, time: '25:00' })).toThrow()
    expect(() => db.saveEvent({ ...base, actions: [] })).toThrow()
    expect(() => db.saveEvent({ ...base, actions: [{ type: 'stream', url: 'ftp://x', minutes: 5, title: '' }] })).toThrow()
    db.saveEvent(base)
    // dopo un ripristino gli eventi con un comando esterno si spengono, gli altri no
    const cmdId = db.saveEvent({ ...base, label: 'Script', time: '09:00', actions: [{ type: 'command', command: 'echo x' }] })
    expect(db.disableCommandEvents()).toEqual(['Script'])
    expect(db.listEvents().find((e) => e.id === cmdId)!.enabled).toBe(false)
    expect(db.listEvents().find((e) => e.id !== cmdId)!.enabled).toBe(true)
    db.deleteEvent(cmdId)
    expect(db.listEvents()[0]).toMatchObject({ time: '08:00', days: [1, 2], mode: 'hard', actions: [{ type: 'play', trackId: id }] })

    const logId = db.logStart(db.getTrack(id)!, new Date('2026-11-16T10:00:00Z'))
    db.logEnd(logId, new Date('2026-11-16T10:01:40Z'), 100)
    const log = db.listLog(new Date('2026-11-16T00:00:00Z'), new Date('2026-11-17T00:00:00Z'))
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ title: 'A', composer: 'C', siaeCode: '00123', playedSeconds: 100 })
    db.close()
  })
})
