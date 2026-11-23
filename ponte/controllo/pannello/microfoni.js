// Pannello: due microfoni sullo stesso dispositivo (richiesta di cristian, 23/11/2026).
// Ogni microfono = un ingresso del dispositivo (o un solo canale di una scheda audio a 2 ingressi), con volume e
// muto. Il mix avviene nel browser: al ponte arriva sempre UNA traccia, come prima (server invariato).
// La parte senza browser (pianoCattura) è provata in tests/microfoni.test.ts.
'use strict'

/** Canali possibili di un microfono: tutto l'ingresso, oppure solo il canale 1 (sinistro) o 2 (destro). */
const CANALI_MIC = { tutti: 'Tutto l\'ingresso', c1: 'Solo canale 1 (sinistro)', c2: 'Solo canale 2 (destro)' }

/**
 * Da quello che hai scelto (mic 1 sempre, mic 2 se ha un ingresso) a cosa aprire: ogni ingresso una volta sola,
 * in stereo se a qualcuno serve un canale preciso. Con un canale preciso il browser non deve elaborare la voce
 * (l'eliminazione dell'eco rende l'ingresso mono e i due canali diventerebbero uguali).
 * scelte: [{ device: '' | id | null, channel: 'tutti'|'c1'|'c2' }]  (device null = microfono non usato)
 */
function pianoCattura(scelte, cuffie) {
  const usati = []
  const aperture = []
  for (const [i, s] of (Array.isArray(scelte) ? scelte : []).entries()) {
    if (!s || s.device === null || s.device === undefined) continue
    const device = String(s.device)
    const channel = Object.prototype.hasOwnProperty.call(CANALI_MIC, s.channel) ? s.channel : 'tutti'
    let a = aperture.find((x) => x.device === device)
    if (!a) {
      a = { device, stereo: false }
      aperture.push(a)
    }
    if (channel !== 'tutti') a.stereo = true
    usati.push({ mic: i, device, channel })
  }
  for (const a of aperture) {
    const elabora = !cuffie && !a.stereo
    a.constraints = {
      deviceId: a.device ? { exact: a.device } : undefined,
      echoCancellation: elabora,
      noiseSuppression: elabora,
      autoGainControl: elabora,
      channelCount: a.stereo ? { ideal: 2 } : 1
    }
  }
  const doppio = usati.length === 2 && usati[0].device === usati[1].device && usati[0].channel === usati[1].channel
  return { aperture, usati, doppio, senzaEco: !cuffie && aperture.some((a) => a.stereo) }
}

/** Livello di picco in dB e percentuale della barra (-60 dB = vuota). */
function livelloMic(an, buf) {
  an.getFloatTimeDomainData(buf)
  let peak = 0
  for (const v of buf) peak = Math.max(peak, Math.abs(v))
  const db = peak > 0 ? 20 * Math.log10(peak) : -60
  return { db, pct: Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) }
}

/**
 * Apre gli ingressi del piano e li mixa in una traccia mono. Restituisce { stream, mic: [{ gain, an }], tot, ctx, stop }.
 * volumi/muti: indicizzati come le scelte.
 */
async function apriMixMicrofoni(piano, volumi, muti) {
  const streams = []
  try {
    for (const a of piano.aperture) streams.push(await navigator.mediaDevices.getUserMedia({ audio: a.constraints }))
  } catch (e) {
    for (const s of streams) for (const t of s.getTracks()) t.stop()
    throw e
  }
  const ctx = new AudioContext()
  const dest = ctx.createMediaStreamDestination()
  dest.channelCount = 1
  const tot = ctx.createAnalyser()
  tot.fftSize = 1024
  const somma = ctx.createGain()
  somma.channelCount = 1
  somma.channelCountMode = 'explicit'
  somma.connect(dest)
  somma.connect(tot)
  const sorgenti = new Map()
  piano.aperture.forEach((a, i) => sorgenti.set(a.device, ctx.createMediaStreamSource(streams[i])))
  const mic = []
  for (const u of piano.usati) {
    const src = sorgenti.get(u.device)
    const gain = ctx.createGain()
    gain.channelCount = 1
    gain.channelCountMode = 'explicit' // tutto l'ingresso: stereo → mono
    gain.gain.value = muti[u.mic] ? 0 : Number(volumi[u.mic] ?? 1)
    if (u.channel === 'tutti') src.connect(gain)
    else {
      const split = ctx.createChannelSplitter(2)
      src.connect(split)
      // se il dispositivo dà un solo canale, il canale 2 resta muto: lo dice la barra del microfono
      split.connect(gain, u.channel === 'c1' ? 0 : 1)
    }
    const an = ctx.createAnalyser()
    an.fftSize = 1024
    gain.connect(an)
    gain.connect(somma)
    mic[u.mic] = { gain, an }
  }
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
  return {
    stream: dest.stream,
    mic,
    tot,
    ctx,
    stop() {
      for (const s of streams) for (const t of s.getTracks()) t.stop()
      ctx.close().catch(() => {})
    }
  }
}

/** Ingressi audio del dispositivo; se il browser nasconde i nomi chiede il permesso una volta. */
async function elencoIngressi(chiediPermesso) {
  let all = await navigator.mediaDevices.enumerateDevices()
  const senzaNomi = all.some((d) => d.kind === 'audioinput' && !d.label)
  if (senzaNomi && chiediPermesso) {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true })
    for (const t of s.getTracks()) t.stop()
    all = await navigator.mediaDevices.enumerateDevices()
  }
  return all
    .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Ingresso ${i + 1}` }))
}

if (typeof module !== 'undefined') module.exports = { pianoCattura, livelloMic, CANALI_MIC }
