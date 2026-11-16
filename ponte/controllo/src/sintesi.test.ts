import { execFileSync, spawn as spawnChild } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { cleanVoice, DEFAULT_VOICE, fillTemplate, programContext, sentences, spokenTime, Synth, voiceFilter, voiceUrl, wav, type TtsEngine } from './sintesi.ts'

const ffmpeg = (createRequire(import.meta.url)('../../../node_modules/ffmpeg-static') as string) || 'ffmpeg'

describe('testo degli annunci', () => {
  it('dice l\'ora come a voce', () => {
    expect(spokenTime(new Date(2026, 10, 15, 22, 50))).toBe('22 e 50')
    expect(spokenTime(new Date(2026, 10, 15, 23, 0))).toBe('23 in punto')
    expect(spokenTime(new Date(2026, 10, 15, 0, 0))).toBe('mezzanotte')
    expect(spokenTime(new Date(2026, 10, 15, 0, 5))).toBe('mezzanotte e 5')
    expect(spokenTime(new Date(2026, 10, 15, 12, 0))).toBe('mezzogiorno')
  })

  it('riempie le parti e segnala quelle che mancano', () => {
    const r = fillTemplate('Sono le {ora} di {data}. Avete ascoltato {brano} di {artista} su {radio}. Poi {prossimo_programma} alle {ora_prossimo_programma}. {sconosciuto}', {
      now: new Date(2026, 10, 15, 22, 50),
      radio: 'Radio Attiva',
      track: { title: 'Caruso', artist: 'Lucio Dalla' },
      nextProgram: { title: 'Notte jazz', at: new Date(2026, 10, 15, 23, 0) }
    })
    expect(r.text).toBe('Sono le 22 e 50 di domenica 15 novembre. Avete ascoltato Caruso di Lucio Dalla su Radio Attiva. Poi Notte jazz alle 23 in punto. {sconosciuto}')
    expect(r.missing).toEqual([])
    const m = fillTemplate('Avete ascoltato {brano} . Ora {programma}.', { now: new Date() })
    expect(m).toEqual({ text: 'Avete ascoltato. Ora.', missing: ['brano', 'programma'] })
  })

  it('divide in frasi', () => {
    expect(sentences('Ciao a tutti.  Sono le 22!\nE adesso musica…  ...')).toEqual(['Ciao a tutti.', 'Sono le 22!', 'E adesso musica…'])
  })

  it('programma in onda e prossimo dalle fasce', () => {
    const now = new Date(2026, 10, 15, 23, 30) // domenica
    const progs = [
      { title: 'Notte', slots: [{ days: [0], start: '23:00', end: '01:00' }] },
      { title: 'Mattino', slots: [{ days: [1, 2, 3, 4, 5], start: '07:00', end: '09:00' }] },
      { title: 'Senza fasce' }
    ]
    expect(programContext(progs, now)).toEqual({ program: 'Notte', nextProgram: { title: 'Mattino', at: new Date(2026, 10, 16, 7, 0) } })
    // dopo mezzanotte la fascia di ieri è ancora in onda
    expect(programContext(progs, new Date(2026, 10, 16, 0, 30)).program).toBe('Notte')
  })

  it('impostazioni nei limiti e filtro di tono e volume', () => {
    expect(cleanVoice({ voice: 'altra', speed: 9, pitch: -20, volumeDb: Number.NaN })).toEqual({ ...DEFAULT_VOICE, speed: 2, pitch: -6 })
    expect(voiceFilter(DEFAULT_VOICE, 22050)).toBe('adelay=200:all=1,apad=pad_dur=0.4')
    expect(voiceFilter({ ...DEFAULT_VOICE, pitch: 12, volumeDb: 3 }, 22050)).toBe('asetrate=44100,aresample=22050,atempo=0.5000,volume=3dB,adelay=200:all=1,apad=pad_dur=0.4')
    expect(voiceUrl('it_IT-paola-medium')).toBe('https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-it_IT-paola-medium.tar.bz2')
    expect(() => voiceUrl('../x')).toThrow()
  })
})

describe('voce sintetica', () => {
  /** Finta voce scaricabile: un archivio .tar.bz2 come quelli veri. */
  function fakeVoiceArchive(): Buffer {
    const src = mkdtempSync(join(tmpdir(), 'voce-src-'))
    const d = join(src, 'vits-piper-it_IT-paola-medium')
    mkdirSync(join(d, 'espeak-ng-data'), { recursive: true })
    writeFileSync(join(d, 'it_IT-paola-medium.onnx'), 'x')
    writeFileSync(join(d, 'tokens.txt'), 'x')
    execFileSync('tar', ['-cjf', join(src, 'v.tar.bz2'), '-C', src, 'vits-piper-it_IT-paola-medium'])
    return readFileSync(join(src, 'v.tar.bz2'))
  }

  it('scarica la voce la prima volta, produce l\'MP3 e lo riusa', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voce-'))
    const archive = fakeVoiceArchive()
    const downloads: string[] = []
    const generated: { text: string; speed: number }[] = []
    const engine = async (): Promise<TtsEngine> => ({
      sampleRate: 22050,
      generate: async (text, speed) => {
        generated.push({ text, speed })
        return new Float32Array(22050).map((_, i) => Math.sin(i / 10) * 0.3)
      }
    })
    const synth = new Synth({
      voicesDir: join(dir, 'voci'),
      outDir: join(dir, 'annunci'),
      ffmpeg,
      engine,
      fetch: async (url) => {
        downloads.push(url)
        return new Response(new Uint8Array(archive))
      }
    })
    expect(synth.voices().find((v) => v.id === 'it_IT-paola-medium')?.installed).toBe(false)
    const r = await synth.speak('Prima frase. Seconda frase!', { speed: 1.2, sentencePause: 0.5 })
    expect(downloads).toEqual([voiceUrl('it_IT-paola-medium')])
    expect(synth.hasVoice('it_IT-paola-medium')).toBe(true)
    expect(generated).toEqual([
      { text: 'Prima frase.', speed: 1.2 },
      { text: 'Seconda frase!', speed: 1.2 }
    ])
    expect(existsSync(r.file)).toBe(true)
    // 1 s + 0,5 s di pausa + 1 s, più 0,2 s prima e 0,4 s dopo
    expect(r.seconds).toBeGreaterThanOrEqual(3)
    expect(r.seconds).toBeLessThanOrEqual(4)
    const again = await synth.speak('Prima frase.   Seconda frase!', { speed: 1.2, sentencePause: 0.5 })
    expect(again.file).toBe(r.file)
    expect(generated).toHaveLength(2)
    await synth.removeVoice('it_IT-paola-medium')
    expect(synth.hasVoice('it_IT-paola-medium')).toBe(false)
  })

  it('errori chiari', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voce-'))
    const synth = new Synth({ voicesDir: dir, outDir: dir, ffmpeg, fetch: async () => new Response('no', { status: 404 }) })
    await expect(synth.speak('  ...  ', {})).rejects.toThrow('testo vuoto')
    await expect(synth.speak('Ciao.', {})).rejects.toThrow('(404)')
  })

  it('WAV a 16 bit', () => {
    const b = wav(new Float32Array([0, 1, -1, 2]), 16000)
    expect(b.toString('ascii', 0, 4)).toBe('RIFF')
    expect(b.readUInt32LE(24)).toBe(16000)
    expect([b.readInt16LE(44), b.readInt16LE(46), b.readInt16LE(48), b.readInt16LE(50)]).toEqual([0, 32767, -32767, 32767])
  })
})

describe('voce sintetica: usi sbagliati e guasti', () => {
  const okEngine = (calls: string[], delay = 0) => async (): Promise<TtsEngine> => ({
    sampleRate: 16000,
    generate: async (text) => {
      calls.push(text)
      if (delay) await new Promise((r) => setTimeout(r, delay))
      return new Float32Array(1600).fill(0.1)
    }
  })
  /** Voce già "scaricata" (file finti). */
  function withVoice(): string {
    const dir = mkdtempSync(join(tmpdir(), 'voce-'))
    const d = join(dir, 'vits-piper-it_IT-paola-medium')
    mkdirSync(join(d, 'espeak-ng-data'), { recursive: true })
    writeFileSync(join(d, 'it_IT-paola-medium.onnx'), 'x')
    writeFileSync(join(d, 'tokens.txt'), 'x')
    return dir
  }

  it('titoli enormi o con a capo nei tag non allungano l\'annuncio', () => {
    const r = fillTemplate('Avete ascoltato {brano}.', { now: new Date(), track: { title: `Titolo\nlungo ${'parola '.repeat(500)}`, artist: '' } })
    expect(r.text.length).toBeLessThan(200)
    expect(r.text).not.toContain('\n')
    expect(r.text.startsWith('Avete ascoltato Titolo lungo parola')).toBe(true)
  })

  it('testo troppo lungo rifiutato prima di fare qualsiasi cosa', async () => {
    const dir = withVoice()
    const calls: string[] = []
    const synth = new Synth({ voicesDir: dir, outDir: join(dir, 'out'), ffmpeg, engine: okEngine(calls) })
    await expect(synth.speak('a. '.repeat(2000), {})).rejects.toThrow(/troppo lungo/)
    expect(calls).toEqual([])
  })

  it('stesso annuncio chiesto due volte insieme: prodotto una volta sola; annunci diversi uno alla volta', async () => {
    const dir = withVoice()
    const calls: string[] = []
    let running = 0
    let maxRunning = 0
    const engine = async (): Promise<TtsEngine> => ({
      sampleRate: 16000,
      generate: async (text) => {
        calls.push(text)
        maxRunning = Math.max(maxRunning, ++running)
        await new Promise((r) => setTimeout(r, 20))
        running--
        return new Float32Array(1600).fill(0.1)
      }
    })
    const synth = new Synth({ voicesDir: dir, outDir: join(dir, 'out'), ffmpeg, engine })
    const [a, b, c] = await Promise.all([synth.speak('Ciao.', {}), synth.speak('Ciao.', {}), synth.speak('Altro.', {})])
    expect(a.file).toBe(b.file)
    expect(c.file).not.toBe(a.file)
    expect(calls.sort()).toEqual(['Altro.', 'Ciao.'])
    expect(maxRunning).toBe(1)
  })

  it('voce bloccata: errore dopo il tempo massimo, e la volta dopo si riapre', async () => {
    const dir = withVoice()
    let opened = 0
    let hang = true
    const engine = async (): Promise<TtsEngine> => {
      opened++
      return {
        sampleRate: 16000,
        generate: (): Promise<Float32Array> => (hang ? new Promise(() => {}) : Promise.resolve(new Float32Array(1600).fill(0.1)))
      }
    }
    const synth = new Synth({ voicesDir: dir, outDir: join(dir, 'out'), ffmpeg, engine, sentenceTimeoutMs: 50 })
    await expect(synth.speak('Ciao.', {})).rejects.toThrow(/non risponde/)
    hang = false
    expect((await synth.speak('Ciao.', {})).seconds).toBeGreaterThan(0)
    expect(opened).toBe(2)
  })

  it('modello rotto: errore chiaro', async () => {
    const dir = withVoice()
    const synth = new Synth({ voicesDir: dir, outDir: join(dir, 'out'), ffmpeg, engine: async () => { throw new Error('Load model failed') } })
    await expect(synth.speak('Ciao.', {})).rejects.toThrow(/la voce non si apre .*scaricala di nuovo/)
  })

  it('ffmpeg bloccato: chiuso dopo il tempo massimo', async () => {
    const dir = withVoice()
    const synth = new Synth({
      voicesDir: dir,
      outDir: join(dir, 'out'),
      ffmpeg: process.execPath,
      ffmpegTimeoutMs: 200,
      engine: okEngine([]),
      // al posto di ffmpeg un programma che non finisce mai
      spawn: (cmd) => spawnChild(cmd, ['-e', 'setInterval(() => {}, 1000)'])
    })
    await expect(synth.speak('Ciao.', {})).rejects.toThrow(/non ha finito/)
  })

  it('archivio della voce rovinato: la voce non risulta installata e non resta niente a metà', async () => {
    const src = mkdtempSync(join(tmpdir(), 'voce-src-'))
    const d = join(src, 'vits-piper-it_IT-paola-medium')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'it_IT-paola-medium.onnx'), 'x') // mancano tokens ed espeak
    execFileSync('tar', ['-cjf', join(src, 'v.tar.bz2'), '-C', src, 'vits-piper-it_IT-paola-medium'])
    const dir = mkdtempSync(join(tmpdir(), 'voce-'))
    const synth = new Synth({ voicesDir: dir, outDir: join(dir, 'out'), ffmpeg, engine: okEngine([]), fetch: async () => new Response(new Uint8Array(readFileSync(join(src, 'v.tar.bz2')))) })
    await expect(synth.installVoice('it_IT-paola-medium')).rejects.toThrow(/non trovata/)
    expect(synth.hasVoice('it_IT-paola-medium')).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })
})
