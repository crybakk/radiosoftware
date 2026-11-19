# Novità

## Prossima versione

### Regia

- Pulizia della libreria (Libreria → Pulizia): lista "Da controllare" dei brani che non sembrano radiofonici
  (titoli tipo "Track 01", live@, nomi di file o registrazioni al posto del titolo, live e interviste) e dei
  doppioni, con la copia migliore già scelta. Niente si toglie da solo: selezioni (anche tutti insieme) e togli.
- Un brano si toglie dalla libreria senza cancellare il file; volendo il file si sposta nella sottocartella
  "_Tolti dalla libreria" della cartella musica, per cancellarlo a mano. I brani tolti si rimettono quando vuoi.
- Ricerca dei brani con filtri per titolo, artista, album, genere, anno e ordine; selezione multipla.
- La libreria del server si vede subito (regia e pannello), senza dover prima cercare.

### Server (ponte)

- Flusso HLS con tre qualità AAC (64, 128 e 192 kbit/s) scelte dal lettore in base alla rete, all'indirizzo di
  AzuraCast `/hls/<stazione>/live.m3u8`; anche `/api/nowplaying` lo indica come AzuraCast (`hls_url`). Gli
  ascoltatori HLS contano nel totale.
- Player pubblico sull'HLS, con l'MP3 come riserva; mentre carica il pulsante ▶ gira.
- Predisposizione per Stereo Tool: quinta scelta del processore audio, preset `.sts` caricato dal pannello, chiave
  di licenza facoltativa; se non parte si usa il processore "medio" e arriva un allarme.
- Ascoltando in HLS il player pubblico cambia titolo e copertina con 30 s di ritardo; gli annunci a orario del
  server partono 30 s prima e dicono l'ora prevista (entrambi regolabili).
- Il processore audio ora si applica una volta sola, dopo la scelta tra programma e musica di emergenza.
- Nuovi utenti del pannello invitati con un link: l'amministratore sceglie nome e ruolo, chi riceve il link sceglie
  la password ed entra. Il link vale 7 giorni e una volta sola, e si può annullare.
- Schede di benvenuto al primo accesso nel pannello, diverse secondo il ruolo; si rivedono dal menu ☰ → 👋 Benvenuto.
  Gli utenti che esistevano già non le vedono da sole.

## v0.1.0 — 16 novembre 2026 (anteprima)

Prima versione pubblicata. È un'**anteprima**: tutto è provato in automatico, ma la regia non è ancora stata
provata sull'hardware vero (RodeCaster Duo) né il server in onda per davvero.

### File da scaricare

- **RadioRegia-Setup-0.1.0.exe**: installer della regia per il PC di studio (Windows 64 bit). Il programma non è
  firmato: se Windows avvisa, "Ulteriori informazioni" → "Esegui comunque".
- **RadioPonte-server-0.1.0.zip**: il server (ponte, Icecast, Caddy) con la guida. Si copia nella VM ed è pronto per
  `sudo DOMINIO=... bash ponte/installa-server.sh` (vedi la guida, sezione "Il server su Proxmox").
- **SHA256SUMS.txt**: le impronte dei file, per controllare che siano scaricati interi.

### Regia (PC di studio)

- Libreria con tag ID3, analisi automatica (volume EBU R128, inizio/fine utile, punto di mix), scheda brano.
- Messa in onda automatica e manuale, coda, dissolvenze, 12 jingle istantanei, VU meter, preascolto in cuffia.
- Rotazione con separazione artista/brano e jingle; rotazioni generate con l'AI (modello locale) dai generi
  di MusicBrainz.
- Eventi a orario come sequenze di azioni (brani, playlist, flussi, profili di rotazione, repliche, comandi).
- Dati dei brani da MusicBrainz, Discogs, Last.fm e AcoustID (fpcalc incluso nell'installer).
- Notiziari e podcast scaricati da soli, annunci con voce sintetica.
- Registro di trasmissione e report SIAE trimestrale in CSV per il portale.
- Collegamento al server anche dietro il NAT del 4G (SRT cifrato, riconnessione automatica), backup giornaliero
  sul server, statistiche degli ascoltatori.
- Guida con gli screenshot dentro il programma.

### Server (ponte)

- Una sola VM: ponte, Icecast principale e Caddy con HTTPS automatico; niente più AzuraCast.
- Icecast secondario con lo stesso segnale, processore audio d'uscita, musica di riserva quando nessuno è in onda.
- Pannello web su `/dashboard` per telefono e computer: comandi della regia, microfono in diretta (WebRTC),
  diretta autonoma con la libreria del server, fino a 3 ospiti con un link, utenti con ruoli,
  impostazioni del server.
- Dirette esterne con riconoscimento dei brani e etichettatura degli sconosciuti (anche dal bot Telegram).
- Programmi, registrazione automatica, puntate on demand (solo ascolto), repliche; player pubblico su `/`,
  API podcast e nowplaying compatibili con AzuraCast.
- Dirette video su YouTube e Facebook (logo o video da OBS).
- Allarmi via Telegram ed email, statistiche degli ascoltatori per un anno.
