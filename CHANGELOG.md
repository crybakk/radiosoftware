# Novità

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
