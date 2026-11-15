import { describe, expect, it, vi } from 'vitest'

// --- finti oggetti Web Audio / mediaDevices per far girare UplinkCapture in Node ---
const liveNodes = new Set<FakeNode>()
class FakeNode {
  port = { onmessage: null as ((e: { data: ArrayBuffer }) => void) | null }
  connected = false
  constructor() {
    liveNodes.add(this)
  }
  connect() {
    this.connected = true
  }
  disconnect() {
    this.connected = false
    liveNodes.delete(this)
  }
}
const openTracks = new Set<{ stop: () => void }>()
;(globalThis as any).AudioWorkletNode = FakeNode
;(globalThis as any).navigator.mediaDevices = {
  getUserMedia: async () => {
    // l'ingresso audio impiega un po' ad aprirsi (permessi, driver)
    await new Promise((r) => setTimeout(r, 50))
    const track = { stop: () => openTracks.delete(track) }
    openTracks.add(track)
    return { getTracks: () => [track] }
  }
}
const ctx = {
  state: 'running',
  destination: { connect() {}, disconnect() {} },
  audioWorklet: { addModule: async () => {} },
  createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
  createMediaStreamSource: () => ({ connect: (n: FakeNode) => n.connect(), disconnect() {} }),
  resume: async () => {}
}
vi.mock('../src/renderer/src/pcm-worklet.js?url&no-inline', () => ({ default: 'worklet.js' }))

describe('UplinkCapture: avvii sovrapposti', () => {
  it('due start() ravvicinati (cambio ingresso) lasciano un solo nodo attivo e un solo microfono aperto', async () => {
    const { UplinkCapture } = await import('../src/renderer/src/uplinkCapture')
    const sent: string[] = []
    const cap = new UplinkCapture(ctx as any, { connect() {}, disconnect() {} } as any, () => sent.push('pcm'))
    const a = cap.start({ source: 'ingresso', inputDeviceId: 'A' })
    const b = cap.start({ source: 'ingresso', inputDeviceId: 'B' })
    await Promise.all([a, b])
    // ogni nodo vivo con onmessage manda PCM a ffmpeg: due nodi = audio doppio/mescolato
    const sending = [...liveNodes].filter((n) => n.port.onmessage)
    expect(sending.length).toBe(1)
    expect(openTracks.size).toBe(1)
  })

  it('stop() durante uno start() in corso deve fermare davvero la cattura', async () => {
    liveNodes.clear()
    openTracks.clear()
    const { UplinkCapture } = await import('../src/renderer/src/uplinkCapture')
    const cap = new UplinkCapture(ctx as any, { connect() {}, disconnect() {} } as any, () => {})
    const p = cap.start({ source: 'ingresso', inputDeviceId: 'A' })
    cap.stop() // invio spento mentre il microfono si stava aprendo
    await p
    expect(cap.active).toBe(false)
    expect(openTracks.size).toBe(0)
  })

  it('dopo uno stop() a metà, un nuovo start() funziona normalmente', async () => {
    liveNodes.clear()
    openTracks.clear()
    const { UplinkCapture } = await import('../src/renderer/src/uplinkCapture')
    const cap = new UplinkCapture(ctx as any, { connect() {}, disconnect() {} } as any, () => {})
    const p = cap.start({ source: 'ingresso', inputDeviceId: 'A' })
    cap.stop()
    await p
    await cap.start({ source: 'programma', inputDeviceId: '' })
    expect(cap.active).toBe(true)
    expect([...liveNodes].filter((n) => n.port.onmessage).length).toBe(1)
    expect(openTracks.size).toBe(0)
    cap.stop()
    expect(liveNodes.size).toBe(0)
  })
})
