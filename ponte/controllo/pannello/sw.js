// Service worker del player pubblico installato come app (27/11/2026).
// Tiene in memoria solo la "scatola" del player (pagina, stile, script, icone), così l'app si apre anche con la
// rete lenta e, senza rete, dice in italiano che manca la connessione. Diretta, titoli, HLS e MP3 non passano
// mai di qui: vanno sempre in rete, come nel browser.
'use strict'
const CACHE = 'player-v1'
const GUSCIO = ['/', '/pubblico.css', '/player.js', '/installa.js', '/podcast.html', '/podcast.js', '/icona-192.png', '/icona-512.png']

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => Promise.allSettled(GUSCIO.map((u) => c.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((k) => Promise.all(k.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  )
})

const OFFLINE = `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nessuna connessione</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1216;color:#eef1f5;
font-family:system-ui,sans-serif;text-align:center;padding:24px}p{color:#8d97a8}a{display:inline-block;margin-top:12px;padding:12px 22px;
border-radius:999px;background:#ef4444;color:#fff;text-decoration:none;font-weight:700}</style></head><body><div><h1>Nessuna connessione</h1>
<p>Il telefono non è collegato a Internet. Quando torna la rete, premi il pulsante.</p><a href="/">Riprova</a></div></body></html>`

function pagina(url) {
  return url.pathname === '/' || url.pathname === '/podcast.html'
}

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  const chiave = url.pathname
  const inGuscio = GUSCIO.includes(url.pathname)
  if (req.mode !== 'navigate' && !inGuscio) return
  if (req.mode === 'navigate' && !pagina(url)) return
  // prima la rete (così si vede subito la versione nuova), la copia in memoria solo se la rete non risponde
  e.respondWith(
    fetch(req)
      .then((r) => {
        if (r.ok && inGuscio) {
          const copia = r.clone()
          caches.open(CACHE).then((c) => c.put(chiave, copia))
        }
        return r
      })
      .catch(async () => {
        const c = await caches.match(chiave)
        if (c) return c
        if (req.mode === 'navigate') return new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
        return Response.error()
      })
  )
})
