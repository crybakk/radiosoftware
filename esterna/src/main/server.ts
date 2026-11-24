/** Richieste HTTP dell'app Radio Esterna al server (con il cookie della sessione del pannello). */
import type { FineRegia, ProgrammaStudio } from '../../../src/core/registrazioneProgrammi.ts'
import type { Programma } from '../shared/api'

export class ServerHttp {
  constructor(
    private readonly base: string,
    private readonly token: string
  ) {}

  private async req(method: string, path: string, body?: BodyInit, type?: string, timeoutMs = 15_000): Promise<Response> {
    let r: Response
    try {
      r = await fetch(this.base + path, {
        method,
        headers: { Cookie: `sessione=${this.token}`, ...(type ? { 'Content-Type': type } : {}) },
        body,
        signal: AbortSignal.timeout(timeoutMs),
        ...(body && typeof (body as ReadableStream).getReader === 'function' ? { duplex: 'half' } : {})
      } as RequestInit)
    } catch (e) {
      throw new Error(e instanceof Error && e.name === 'TimeoutError' ? 'il server non risponde' : 'server non raggiungibile')
    }
    if (r.status === 401) throw new Error('accesso scaduto: entra di nuovo')
    if (!r.ok) {
      const j = (await r.json().catch(() => null)) as { error?: string } | null
      throw new Error(j?.error ?? `errore del server (HTTP ${r.status})`)
    }
    return r
  }

  async programmi(): Promise<Programma[]> {
    const list = (await (await this.req('GET', '/api/programmi/esterna')).json()) as Programma[]
    return Array.isArray(list) ? list.filter((p) => p && typeof p.id === 'string').map((p) => ({ id: p.id, title: String(p.title) })) : []
  }

  /** Programmi per la registrazione delle puntate: tutti scelti a mano (niente partenze automatiche dalle fasce). */
  async programmiPerRegistrare(): Promise<ProgrammaStudio[]> {
    return (await this.programmi()).map((p) => ({ id: p.id, title: p.title, studio: true, slots: [] }))
  }

  /** Il ponte comincia a registrare il programma (la sua registrazione si tiene se il collegamento non cade). */
  async inizio(programId: string): Promise<{ ok: boolean; motivo?: string }> {
    return (await (await this.req('POST', '/api/programmi/esterna/inizio', JSON.stringify({ programId }), 'application/json')).json()) as { ok: boolean; motivo?: string }
  }

  async fine(f: FineRegia): Promise<{ usa: 'ponte' | 'regia' }> {
    return (await (await this.req('POST', '/api/programmi/esterna/fine', JSON.stringify(f), 'application/json', 30_000)).json()) as { usa: 'ponte' | 'regia' }
  }

  async invia(f: FineRegia, body: ReadableStream<Uint8Array>): Promise<void> {
    const q = new URLSearchParams({
      programId: f.programId,
      startedAt: String(f.startedAt),
      endedAt: String(f.endedAt),
      startMark: f.startMark === null ? '' : String(f.startMark),
      endMark: f.endMark === null ? '' : String(f.endMark),
      startAuto: f.startAuto ? '1' : '0',
      endAuto: f.endAuto ? '1' : '0'
    })
    await this.req('PUT', `/api/programmi/esterna/registrazione?${q}`, body, 'audio/mpeg', 6 * 3600_000)
  }

  /** Controlla che la sessione salvata valga ancora. */
  async io(): Promise<{ name: string; role: string } | null> {
    try {
      const j = (await (await this.req('GET', '/api/io')).json()) as { user?: { name: string; role: string } }
      return j.user ?? null
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('accesso scaduto')) return null
      throw e
    }
  }
}
