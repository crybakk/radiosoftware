import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AI_MODEL, AiService, downloadResumable, type LlmEngine } from '../src/main/ai'
import { makeTrack } from './helpers'

const tmp = () => mkdtempSync(join(tmpdir(), 'ai-'))

describe('scaricamento del modello', () => {
  it('riprende da dove si era fermato', async () => {
    const dest = join(tmp(), 'm.gguf')
    writeFileSync(`${dest}.part`, 'ciao ')
    const seen: (string | undefined)[] = []
    await downloadResumable({
      url: 'https://x/m',
      dest,
      fetch: async (_u, i) => {
        const range = (i.headers as Record<string, string>).Range
        seen.push(range)
        return new Response('mondo', { status: 206, headers: { 'content-length': '5' } })
      }
    })
    expect(seen).toEqual(['bytes=5-'])
    expect(readFileSync(dest, 'utf8')).toBe('ciao mondo')
    expect(existsSync(`${dest}.part`)).toBe(false)
  })

  it('riparte da capo se il server non riprende, e segnala gli errori', async () => {
    const dest = join(tmp(), 'm.gguf')
    writeFileSync(`${dest}.part`, 'vecchio')
    await downloadResumable({ url: 'u', dest, fetch: async () => new Response('tutto', { status: 200 }) })
    expect(readFileSync(dest, 'utf8')).toBe('tutto')
    await expect(downloadResumable({ url: 'u', dest: join(tmp(), 'x'), fetch: async () => new Response('', { status: 404 }) })).rejects.toThrow(/404/)
  })
})

describe('AI delle rotazioni', () => {
  const music = [makeTrack({ genre: 'Pop', year: 1985 }), makeTrack({ genre: 'Jazz', year: 1960 })]

  it('genera il piano con il modello e lo ricontrolla', async () => {
    const dir = tmp()
    let asked: { system: string; schema: object } | null = null
    const engine: LlmEngine = {
      complete: async (o) => {
        asked = o
        return JSON.stringify({ slots: [{ name: 'Mattina', days: [1, 2, 3, 4, 5], start: '07:00', end: '10:00', genres: ['pop', 'rock'], yearFrom: null, yearTo: null, artistSeparationMinutes: null, jingleEvery: null }] })
      }
    }
    const ai = new AiService({ dir, engine })
    await expect(ai.generate('pop la mattina', music)).rejects.toThrow(/scarica prima/)
    writeFileSync(join(dir, AI_MODEL.file), 'gguf')
    expect(ai.status()).toMatchObject({ installed: true, downloading: false, busy: false })
    const r = await ai.generate('pop la mattina', music)
    expect(asked!.system).toContain('jazz (1), pop (1)')
    expect(JSON.stringify(asked!.schema)).toContain('"enum":["jazz","pop"]')
    expect(r.plan.slots[0].genres).toEqual(['pop'])
    expect(r.warnings).toEqual(['"Mattina": il genere "rock" non è nella libreria, tolto'])
    expect([r.counts, r.music]).toEqual([[1], 2])
    await expect(new AiService({ dir, engine: { complete: async () => 'non json' } }).generate('x', music)).rejects.toThrow(/formato non valido/)
  })

  it('scarica il modello mostrando l\'avanzamento', async () => {
    const dir = tmp()
    const states: number[] = []
    const ai = new AiService({
      dir,
      engine: { complete: async () => '{}' },
      fetch: async () => new Response('dati del modello', { headers: { 'content-length': '16' } }),
      onStatus: (s) => states.push(s.progress)
    })
    await ai.download()
    expect(ai.status()).toMatchObject({ installed: true, error: null })
    expect(states.at(-1)).toBe(1)
    await ai.removeModel()
    expect(ai.status().installed).toBe(false)
  })
})
