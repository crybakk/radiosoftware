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
| Funzioni aggiunte | Analisi della libreria stile MusicBrainz e report SIAE dei brani trasmessi (14/11/2026) |

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

### 4.1.1 Analisi della libreria (stile MusicBrainz)

- Per ogni brano si calcola l'**impronta audio** (Chromaprint) e la si confronta con **AcoustID**, che restituisce l'identificativo MusicBrainz anche se il file ha tag sbagliati o mancanti.
- Da **MusicBrainz** si recuperano titolo e artista corretti, album, anno, **ISRC**, durata e, dove presenti, **autori e compositori**, che servono anche per i report SIAE.
- Si ricava anche il genere e lo si usa per categorie e rotazioni.
- Proposte di correzione con anteprima: nulla viene sovrascritto senza conferma. I tag si possono anche scrivere nei file, a scelta.
- Segnalazione di duplicati, brani senza corrispondenza e brani con volume o qualità anomali.
- Limiti: MusicBrainz accetta circa 1 richiesta al secondo e AcoustID richiede una chiave gratuita. Per 20.000 brani la prima analisi richiede quindi diverse ore e gira in background una volta sola. Dopo si analizzano solo i brani nuovi.

### 4.1.2 Registro di trasmissione e report SIAE

- Ogni brano effettivamente andato in onda viene registrato con data, ora, durata reale trasmessa, titolo, artista, autori/compositori, ISRC ed etichetta. Vengono registrati anche i brani mandati dal remoto e quelli dell'AutoDJ di riserva, letti da AzuraCast.
- Licenza: SIAE "radio personale". Serve solo il report SIAE (niente SCF).
- Esportazione per periodo nel tracciato del fac simile SIAE ([docs/siae/template.csv](siae/template.csv)): CSV separato da punto e virgola, **una riga per opera**, con il numero di passaggi nel periodo.

| Colonna SIAE | Da dove arriva |
|---|---|
| TITOLO OPERA | Tag del brano, corretto con MusicBrainz |
| AUTORE | Autori e compositori (MusicBrainz, relazioni "composer" e "lyricist" dell'opera) |
| EDITORE | MusicBrainz, se presente, altrimenti inserimento manuale |
| INTERPRETE | Artista del brano |
| UTILIZZAZIONI | Conteggio dei passaggi effettivi nel periodo |
| PREZZO DI VENDITA | Da chiarire |
| CODICE OPERA | Codice SIAE dell'opera: non è su MusicBrainz, inserimento manuale |
| CODICE ISWC | MusicBrainz (opera) |
| CODICE ISRC | MusicBrainz (registrazione) o tag ID3 TSRC |

- Schermata "brani incompleti" per completare a mano i dati mancanti prima dell'invio. I dati inseriti restano salvati per le esportazioni successive.
- Come in MB Music Report (MB Studio), il report sarà **configurabile**: scelta, ordine e nome delle colonne, campi di testo fissi, filtri (per esempio solo brani con ISRC), modalità "una riga per passaggio" o "una riga per opera con conteggio". Il tracciato SIAE sarà un modello già pronto; se SIAE cambia il fac simile si aggiorna senza toccare il codice.
- Opzione per proteggere da Excel gli zeri iniziali dei codici (per esempio CODICE OPERA).

### 4.1.3 Rotazioni generate con l'AI (richiesta del 14/11/2026)

Descrivi il palinsesto a parole, l'AI propone le rotazioni usando solo i brani che hai nel database. Per esempio: "dal lunedì al venerdì, 7-10 pop italiano energico anni 2000-oggi, un jingle ogni 3 brani, news alle e 30; la sera musica più tranquilla, niente stesso artista entro 90 minuti".

Come funziona:
1. **Profilo dei brani:** oltre ai dati MusicBrainz (genere, anno, lingua), l'analisi audio locale calcola BPM, energia, tonalità e tipo di inizio e fine. Così l'AI ha qualcosa di concreto su cui scegliere.
2. **L'AI traduce la descrizione in regole:** orologi orari (sequenza di categorie, jingle, spot), filtri (genere, anno, energia, lingua), separazioni (artista, titolo, album) e regole di flusso, come l'energia che sale o scende e niente salti bruschi di BPM.
3. **Un motore deterministico genera la rotazione** applicando le regole al database. L'AI non sceglie i brani uno per uno: così il risultato rispetta sempre le separazioni, è ripetibile e si rigenera anche senza internet.
4. **Anteprima e modifica:** vedi la giornata o la settimana generata, puoi correggerla a parole ("meno brani lenti il venerdì sera") o a mano, e la approvi prima che vada in onda.
5. **Segnalazioni:** se il database non basta a coprire una fascia, per esempio troppi pochi brani di quel genere e troppe ripetizioni, il sistema te lo dice invece di riempire a caso.

Dove gira l'AI: **modello locale e leggero** (scelto il 14/11/2026), nessun costo e nessun dato fuori. Il compito è limitato: scegliere, tra le categorie disponibili nel database (generi e tag di MusicBrainz), quelle adatte a ogni fascia del palinsesto, più i parametri delle regole. Basta quindi un modello piccolo (circa 1-4 miliardi di parametri) eseguito con Ollama, con uscita vincolata a uno schema JSON che ammette **solo** le categorie realmente presenti nel database, così l'AI non può inventarne. Gira sul PC di regia anche su sola CPU, in pochi secondi, e si usa solo quando generi o modifichi il palinsesto.

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
- **Modalità "diretta autonoma" (bypass della regia)**, richiesta il 14/11/2026: dal remoto si manda in onda anche la musica senza passare dal PC di regia, per esempio quando il 4G della regia è giù o il PC è spento. Il ponte esclude il flusso della regia e manda ad AzuraCast la voce e la musica che arrivano dal remoto. Al rientro la regia riprende con un tasto, senza sovrapposizioni. Anche questi brani finiscono nel registro SIAE. La musica arriva da **entrambe le fonti** (scelto il 14/11/2026):
  - **libreria sul server:** copia della libreria (intera o una selezione) sincronizzata dalla regia, con gli stessi dati di MusicBrainz e SIAE, riprodotta dal ponte e comandata dal pannello remoto;
  - **file dal dispositivo remoto:** brani o jingle caricati al volo dal pannello e inviati insieme alla voce.
  - La sincronizzazione dalla regia gira in background e riprende da sola dopo le cadute del 4G.
  - Sul server va una **selezione** della libreria. L'analisi della libreria (fase 7) propone cosa escludere, poi si conferma a mano:
    - **versioni live:** release di tipo "Live" su MusicBrainz, titoli con "live", "unplugged" e simili, applausi rilevati dall'analisi audio;
    - **bassa qualità:** bitrate sotto una soglia configurabile (proposta 128 kbps), frequenza di campionamento bassa, file troncati o con clipping;
    - **interviste e parlato:** tipo "Interview" o "Spoken word" su MusicBrainz e prevalenza di voce parlata rilevata dall'analisi audio.
  - Lo stesso filtro si può usare anche per escludere questi brani dalle rotazioni automatiche.

## 5. Latenze attese (stime da verificare in test)

| Percorso | Stima |
|---|---|
| Comando dal pannello remoto alla regia | 50–200 ms sul 4G |
| Voce remota fino al mixer del ponte | 100–300 ms |
| Programma dalla regia al ponte (SRT) | buffer di 0,5–2 s, scelto per stabilità |
| Ritorno in cuffia per chi è in remoto | 300 ms – 2 s |

Chi parla da remoto si ascolta in locale senza ritardo. Il ritardo del ritorno pesa solo quando si parla sopra la coda di un brano. Il buffer SRT si tara in base a quanto è instabile il 4G.

## 6. Fasi di sviluppo proposte

1. **Regia base:** libreria, analisi brani, playout con dissolvenze e jingle, uscita audio verso il RodeCaster, registro di trasmissione.
2. **Ponte e uplink:** Docker sul server, SRT dalla regia, invio ad AzuraCast con AutoDJ di riserva, riconnessione automatica.
3. **Controllo remoto:** pannello web per comandare la regia attraverso il ponte.
4. **Microfono remoto:** WebRTC e mix sul ponte, più la diretta autonoma con musica dal remoto (bypass della regia).
5. **Ospiti:** link ospite, sala d'attesa, mix-minus.
6. **Uscite terze:** Icecast esterni, Fluidstream, YouTube, Facebook.
7. **Analisi libreria e report SIAE:** impronte audio, MusicBrainz, correzione dei tag, esportazione SIAE. Si può anticipare se serve prima.
8. **Rotazioni con l'AI:** profilo audio dei brani, palinsesto descritto a parole, motore di rotazione, anteprima. Richiede l'analisi della libreria della fase 7.

Ogni fase si chiude con una versione usabile e testata prima di passare alla successiva.

## 7. Domande ancora aperte

Vedi il thread di progetto: versione di AzuraCast, risorse del server, porte apribili, eventuale migrazione da RadioDJ, dettagli di Fluidstream, immagine per YouTube/Facebook, dettagli residui del report SIAE.
