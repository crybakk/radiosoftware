import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HlsListeners, hlsPlaylistName, isVariantPlaylist, readHlsPlaylist } from './hls.ts'

describe('flusso HLS', () => {
  it('accetta gli indirizzi come AzuraCast e niente altro', () => {
    expect(hlsPlaylistName('/hls/radio_test/live.m3u8', 'radio_test')).toBe('live.m3u8')
    expect(hlsPlaylistName('/hls/1/aac_hifi.m3u8', 'radio_test')).toBe('aac_hifi.m3u8')
    expect(hlsPlaylistName('/hls/altra/live.m3u8', 'radio_test')).toBeNull()
    expect(hlsPlaylistName('/hls/radio_test/../.env', 'radio_test')).toBeNull()
    expect(hlsPlaylistName('/hls/radio_test/aac_hifi_3.ts', 'radio_test')).toBeNull()
    expect(isVariantPlaylist('live.m3u8')).toBe(false)
    expect(isVariantPlaylist('aac_lofi.m3u8')).toBe(true)
  })

  it('legge la playlist dalla cartella, null se manca', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hls-'))
    writeFileSync(join(dir, 'live.m3u8'), '#EXTM3U\n')
    expect(await readHlsPlaylist(dir, 'live.m3u8')).toBe('#EXTM3U\n')
    expect(await readHlsPlaylist(dir, 'aac_hifi.m3u8')).toBeNull()
  })

  it('conta un ascoltatore per indirizzo e browser finché richiede la playlist', () => {
    let t = 0
    const l = new HlsListeners(() => t)
    l.hit('1.2.3.4', 'Safari')
    l.hit('1.2.3.4', 'Safari')
    l.hit('1.2.3.4', 'Chrome')
    l.hit('5.6.7.8', 'Safari')
    expect(l.count()).toBe(3)
    t = 20_000
    l.hit('5.6.7.8', 'Safari')
    t = 40_000
    expect(l.count()).toBe(1)
    t = 80_000
    expect(l.count()).toBe(0)
  })
})
