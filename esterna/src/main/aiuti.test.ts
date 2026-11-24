import { describe, expect, it } from 'vitest'
import { attesa, normalizzaServer, tokenDaCookie } from './collegamento'
import { argomentiFfmpeg, nomeFile } from './registratore'
import { dmgDaRelease } from './release'
import { guadagno, MAX_CANALI, mixerPredefinito, pulisciMixer } from '../shared/mixer'

describe('Radio Esterna: collegamento', () => {
  it('scrive bene l\'indirizzo del server e vuole HTTPS', () => {
    expect(normalizzaServer(' player.radio.it:9443/ ')).toBe('https://player.radio.it:9443')
    expect(normalizzaServer('https://radio.it/dashboard')).toBe('https://radio.it')
    expect(normalizzaServer('http://localhost:8092')).toBe('http://localhost:8092')
    expect(() => normalizzaServer('http://radio.it')).toThrow(/https/)
    expect(() => normalizzaServer('')).toThrow()
  })

  it('prende il cookie della sessione', () => {
    expect(tokenDaCookie(['altro=1; Path=/', 'sessione=abc123; HttpOnly; Path=/'])).toBe('abc123')
    expect(tokenDaCookie('sessione=xyz; Secure')).toBe('xyz')
    expect(tokenDaCookie(null)).toBeNull()
    expect(tokenDaCookie(['nessuna=1'])).toBeNull()
  })

  it('aspetta sempre di più tra un tentativo e l\'altro, fino a 10 secondi', () => {
    expect([1, 2, 3, 4, 5, 9].map(attesa)).toEqual([1, 2, 4, 8, 10, 10])
  })
})

describe('Radio Esterna: registrazione sul computer', () => {
  it('nome del file senza caratteri vietati', () => {
    const d = new Date(2026, 10, 24, 18, 5, 9)
    expect(nomeFile('Calcio: Roma/Lazio?', d)).toBe('2026-11-24 18.05.09 Calcio Roma Lazio.mp3')
    expect(nomeFile('  ', d)).toBe('2026-11-24 18.05.09 Diretta esterna.mp3')
  })

  it('MP3 a 320 kbit/s', () => {
    const a = argomentiFfmpeg('/x/y.mp3')
    expect(a.slice(a.indexOf('-b:a'), a.indexOf('-b:a') + 2)).toEqual(['-b:a', '320k'])
    expect(a.at(-1)).toBe('/x/y.mp3')
  })
})

describe('Radio Esterna: mixer', () => {
  it('ripara impostazioni rovinate', () => {
    expect(pulisciMixer(null)).toMatchObject({ kbps: 160, ritorno: true })
    const m = pulisciMixer({
      canali: Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, nome: `M${i}`, volumeDb: 99, parte: 'boh', muto: 'si' })),
      pc: { attivo: true, volumeDb: -200 },
      kbps: 999,
      cuffiaVolume: 5
    })
    expect(m.canali).toHaveLength(MAX_CANALI)
    expect(m.canali[0]).toMatchObject({ volumeDb: 12, parte: 'stereo', muto: false })
    expect(m.pc).toMatchObject({ attivo: true, volumeDb: -60 })
    expect(m.kbps).toBe(160)
    expect(m.cuffiaVolume).toBe(1)
    expect(mixerPredefinito().canali).toHaveLength(1)
  })

  it('dB in guadagno', () => {
    expect(guadagno(0)).toBe(1)
    expect(guadagno(-60)).toBe(0)
    expect(guadagno(6, true)).toBe(0)
    expect(guadagno(-6)).toBeCloseTo(0.501, 3)
  })
})

describe('Radio Esterna: aggiornamento sul Mac', () => {
  const rel = [
    {
      tag_name: 'v0.3.0',
      body: '<!-- componenti: {"regia":true,"server":true,"esterna":true} -->',
      assets: [
        { name: 'RadioEsterna-0.3.0-mac-arm64.dmg', browser_download_url: 'https://x/arm64.dmg' },
        { name: 'RadioEsterna-0.3.0-mac-x64.dmg', browser_download_url: 'https://x/x64.dmg' }
      ]
    }
  ]
  it('sceglie il file giusto per il processore', () => {
    expect(dmgDaRelease(rel, '0.3.0', 'arm64')).toBe('https://x/arm64.dmg')
    expect(dmgDaRelease(rel, '0.3.0', 'x64')).toBe('https://x/x64.dmg')
    expect(dmgDaRelease(rel, '0.2.0', 'x64')).toBeNull()
    expect(dmgDaRelease(null, '0.3.0')).toBeNull()
  })
})
