# Architettura

Stato: **bozza da approvare** (14/11/2026). Nulla qui è definitivo finché non viene confermato.

## 1. Obiettivi

- Playout automatico H24 sul PC di regia (playlist, rotazioni, jingle, dissolvenze), simile a RadioDJ.
- Diretta da remoto: microfono, ospiti e controllo completo del player, da browser (PC o telefono).
- Funzionare con il PC di regia dietro NAT 4G instabile, senza aprire porte.
- Integrazione con RodeCaster Duo (USB multitraccia) sul PC di regia.
- Streaming verso AzuraCast e verso servizi terzi (Icecast esterni, Fluidstream, YouTube, Facebook).
- Interfaccia semplicissima.

## 2. Dati di partenza (risposte di cristian)

| Tema | Risposta |
|---|---|
| Sistema operativo PC di regia | Windows |
| Mixer | RodeCaster Duo via USB in multitraccia |
| AzuraCast | Su server proprio, oggi riceve il flusso live da RadioDJ |
| Server ponte | Possibilmente lo stesso server di AzuraCast |
| Interfaccia | Sia app desktop sia web |
| Libreria | Circa 20.000 brani, principalmente MP3 |
| Ospiti remoti | Sì, se possibile |
| Video | No, per ora |
| Uscite terze | Icecast esterni, Fluidstream, YouTube, Facebook |
| Stack | Libero |
| Dove si mixa la diretta remota | **Sul server ponte (mix in cloud)**, scelto il 14/11/2026 |

## 3. Schema generale

```
                         ┌──────────────────────── SERVER (quello di AzuraCast) ───────────────────────┐
 PC DI REGIA (Windows)   │                                                                             │
 dietro NAT 4G           │   PONTE                                                                     │
 ┌──────────────────┐    │   ┌─────────────────────────────┐        ┌───────────────┐                  │
 │ App Regia        │ SRT│   │ ricezione programma (SRT)   │        │  AzuraCast    │──► ascoltatori   │
 │ - libreria       │────┼──►│ mixer (programma + voci)    │──live─►│  (AutoDJ di   │                  │
 │ - playout        │    │   │ WebRTC (microfoni, ospiti)  │        │   riserva)    │                  │
 │ - encoder        │ WS │   │ relay comandi (WebSocket)   │        └───────────────┘                  │
 │                  │◄──►│   │ TURN (per NAT difficili)    │──────► Icecast esterni, Fluidstream      │
 └───────┬──────────┘    │   └─────────────▲───────────────┘──────► YouTube / Facebook (RTMP)         │
         │ USB           │                 │                                                          │
 ┌───────▼──────────┐    └─────────────────┼──────────────────────────────────────────────────────────┘
 │ RodeCaster Duo   │                      │ WebRTC (voce) + WebSocket (comandi)
 │ mic in studio    │            ┌─────────┴──────────┐
 └──────────────────┘            │ Pannello remoto    │  browser su PC o telefono
                                 │ conduttore/ospiti  │
                                 └────────────────────┘
```

Regola chiave: **tutte le connessioni partono dal PC di regia verso il server**. Il NAT 4G non è più un problema perché nessuno deve raggiungere il PC dall'esterno.

## 4. Componenti

### 4.1 App Regia (PC Windows)

- **Tecnologia proposta:** Electron + TypeScript. La stessa interfaccia è servita anche via web, quindi la regia si usa sia dall'app sia dal browser (anche da remoto, passando dal ponte).
- **Libreria:** database SQLite locale. Import dei tag ID3, durata, analisi del volume (loudness EBU R128) per livellare i brani, rilevamento automatico di inizio/fine e punto di mix. Con 20.000 brani l'analisi iniziale gira in background una volta sola.
- **Playout:** due o più lettori con dissolvenza, coda, jingle istantanei (cartwall), rotazioni per categoria, palinsesto orario, modalità automatica e manuale.
- **Audio:** uscita del player verso il RodeCaster Duo via USB, così in studio microfoni e musica si mixano sul RodeCaster. Il segnale di programma (uscita mix del RodeCaster) torna al PC e viene inviato al ponte. I nomi dei canali USB del Duo e il driver (WASAPI o ASIO) vanno verificati sull'hardware reale prima di scrivere questa parte.
- **Uplink verso il server:** protocollo **SRT**. Recupera i pacchetti persi con ritrasmissione e un buffer configurabile, molto adatto al 4G. Codec Opus o AAC, bitrate da decidere.
- **Metadati:** titolo e artista del brano in onda inviati al ponte, che li inoltra ad AzuraCast e alle altre uscite.
- **Se cade il 4G:** la regia continua a suonare in locale, l'uplink si riconnette da solo, e nel frattempo AzuraCast passa alla sua AutoDJ di riserva. Quando la linea torna, si riprende automaticamente.

### 4.2 Ponte (sul server di AzuraCast)

Servizi aggiuntivi in Docker, accanto ad AzuraCast, senza modificarlo:

- **Ricezione programma** via SRT dalla regia.
- **Mixer:** unisce il programma della regia con le voci remote, con ducking automatico della musica quando parla il conduttore. Proposta: Liquidsoap (lo stesso motore usato da AzuraCast) oppure GStreamer.
- **WebRTC:** riceve microfono del conduttore remoto e degli ospiti (Opus). Proposta: mediasoup o LiveKit come server WebRTC.
- **TURN (coturn):** per i client remoti dietro NAT restrittivi.
- **Relay comandi:** WebSocket autenticato tra pannello remoto e regia (play, stop, avanti, jingle, volume).
- **Uscite:** verso AzuraCast come sorgente live (come fa oggi RadioDJ), verso Icecast esterni e Fluidstream, verso YouTube e Facebook via RTMP con un'immagine fissa (logo e titolo in onda), perché queste piattaforme richiedono un video.

Il 4G della regia carica il flusso **una sola volta**: tutte le uscite partono dal server.

### 4.3 Pannello remoto (browser)

- Login con password o link personale.
- Tasto grande **VAI IN ONDA / ESCI**.
- Controllo del player: brano in onda, prossimi brani, play/stop/avanti, jingle.
- Ritorno audio del programma in cuffia.
- Gestione ospiti: invio link, ospite in attesa, in onda, fuori onda. Gli ospiti ricevono il ritorno senza la propria voce (mix-minus).
- Indicatori semplici: stato della connessione della regia e del remoto, livelli audio.

## 5. Latenze attese (stime da verificare in test)

| Percorso | Stima |
|---|---|
| Comando dal pannello remoto alla regia | 50–200 ms sul 4G |
| Voce remota fino al mixer del ponte | 100–300 ms |
| Programma dalla regia al ponte (SRT) | buffer di 0,5–2 s, scelto per stabilità |
| Ritorno in cuffia per chi è in remoto | 300 ms – 2 s |

Chi parla da remoto si ascolta in locale senza ritardo. Il ritardo del ritorno pesa solo quando si parla sopra la coda di un brano. Il buffer SRT si tara in base a quanto è instabile il 4G.

## 6. Fasi di sviluppo proposte

1. **Regia base:** libreria, analisi brani, playout con dissolvenze e jingle, uscita audio verso il RodeCaster.
2. **Ponte e uplink:** Docker sul server, SRT dalla regia, invio ad AzuraCast con AutoDJ di riserva, riconnessione automatica.
3. **Controllo remoto:** pannello web per comandare la regia attraverso il ponte.
4. **Microfono remoto:** WebRTC e mix sul ponte.
5. **Ospiti:** link ospite, sala d'attesa, mix-minus.
6. **Uscite terze:** Icecast esterni, Fluidstream, YouTube, Facebook.

Ogni fase si chiude con una versione usabile e testata prima di passare alla successiva.

## 7. Domande ancora aperte

Vedi il thread di progetto: versione di AzuraCast, risorse del server, porte apribili, eventuale migrazione da RadioDJ, dettagli di Fluidstream e immagine per YouTube/Facebook.
