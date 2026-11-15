# Guida di Radio Regia

Guida d'uso aggiornata a ogni nuova funzione. In fondo trovi l'elenco delle modifiche.

**Ultimo aggiornamento:** 15/11/2026, fase 6 (server senza AzuraCast, musica di riserva, Icecast secondario, dirette video).

## Indice

1. [Come funziona, in breve](#1-come-funziona-in-breve)
2. [Installare la regia su Windows](#2-installare-la-regia-su-windows)
3. [Primo avvio: schede audio e libreria](#3-primo-avvio-schede-audio-e-libreria)
4. [In onda: uso quotidiano](#4-in-onda-uso-quotidiano)
5. [Libreria e scheda brano](#5-libreria-e-scheda-brano)
6. [Eventi a orario](#6-eventi-a-orario)
7. [Registro di trasmissione](#7-registro-di-trasmissione)
8. [Impostazioni](#8-impostazioni)
9. [Il server: VM su Proxmox](#9-il-server-vm-su-proxmox)
    - [Ascolto e Icecast secondario](#ascolto-e-icecast-secondario)
10. [Collegare la regia al ponte](#10-collegare-la-regia-al-ponte)
11. [Dirette esterne](#11-dirette-esterne)
12. [Pannello remoto e utenti](#12-pannello-remoto-e-utenti)
    - [Microfono dal pannello](#microfono-dal-pannello)
    - [Ospiti in diretta](#ospiti-in-diretta)
    - [Diretta autonoma dal server](#diretta-autonoma-dal-server)
    - [Libreria sul server](#libreria-sul-server)
    - [Dirette video su YouTube e Facebook](#dirette-video-su-youtube-e-facebook)
13. [Allarmi e notifiche](#13-allarmi-e-notifiche)
14. [Backup e ripristino](#14-backup-e-ripristino)
15. [Problemi comuni](#15-problemi-comuni)
16. [In arrivo](#16-in-arrivo)
17. [Modifiche alla guida](#17-modifiche-alla-guida)

---

## 1. Come funziona, in breve

```
PC di regia (Windows, 4G) ──▶ Ponte ──▶ Icecast principale (casa) ──▶ ascoltatori
                                 ▲   ├─▶ Icecast secondario (esterno, facoltativo)
App per le esterne ──────────────┘   └─▶ YouTube / Facebook (quando le avvii)
```

- La **regia** è il programma sul PC di regia: sceglie e manda in onda i brani, i jingle e gli eventi.
- Il **ponte** sta sul server di casa, insieme all'**Icecast principale** a cui si collegano gli ascoltatori.
  Riceve l'audio dalla regia, lo tratta con il processore audio e lo manda a tutte le uscite, sempre con lo
  stesso identico segnale.
- Le **dirette esterne** si collegano al ponte. Finché sono collegate vanno in onda loro al posto della regia.
- Se non c'è nessuna diretta (regia spenta o 4G caduto), il ponte suona da solo la **musica di riserva**:
  brani a caso della libreria del server, senza ripetere di seguito lo stesso artista. Quando la regia si
  ricollega la diretta riprende da sola.
- AzuraCast non serve più.

## 2. Installare la regia su Windows

1. Apri il repository su GitHub → scheda **Actions** → l'ultima esecuzione verde di "Test e build Windows".
2. In fondo alla pagina scarica **RadioRegia-Setup-Windows** ed estrai lo zip.
3. Avvia l'installer. Windows potrebbe avvisare che il programma non è firmato: scegli "Ulteriori informazioni" → "Esegui comunque".

Il programma si apre a schermo intero. Può esserne aperta una sola copia alla volta.

## 3. Primo avvio: schede audio e libreria

**Schede audio** (scheda **Impostazioni**):

- **Uscita in onda**: con il RodeCaster Duo collegato via USB, scegli il canale del RodeCaster dedicato al computer.
- **Uscita preascolto**: un'uscita diversa, per esempio le cuffie del PC o il canale chat del RodeCaster.
- Se un'uscita non compare, premi **Aggiorna elenco schede**.

**Libreria** (scheda **Libreria**):

1. Scegli il tipo (Musica, Jingle, Notiziario, Programma, Spot) e premi **+ Aggiungi cartella**.
2. Premi **Aggiorna libreria**: il programma legge i tag dei file (titolo, interprete, autori, editore, ISRC).
3. In sottofondo parte l'analisi dei brani: livella il volume di tutti i brani, trova dove inizia e
   finisce l'audio utile e dove far partire il brano successivo. Con 20.000 brani ci vuole un po', ma
   puoi andare in onda subito.

Quando aggiungi file nuove nelle cartelle, premi di nuovo **Aggiorna libreria**: legge solo le novità.

## 4. In onda: uso quotidiano

Scheda **In onda**:

- In alto a sinistra la spia **IN ONDA / FERMO**. In alto a destra il tasto **AUTOMATICO / MANUALE** e l'orologio.
- **AUTOMATICO**: la regia riempie la coda da sola rispettando le regole di rotazione e non lascia mai il silenzio.
- **MANUALE**: va in onda solo quello che metti in coda tu. Alla fine di un brano parte il successivo in coda.
- **▶ PLAY** fa partire la coda, **⏭ AVANTI** sfuma il brano in onda e passa al successivo, **■ STOP** sfuma e
  ferma tutto (e passa in manuale).
- Il riquadro grande mostra il brano in onda, il tempo trascorso e quello mancante: negli ultimi secondi diventa rosso.
- **Coda**: con le frecce sposti i brani, con la ✕ li togli. Accanto a ogni brano c'è l'orario previsto.
- **Ricerca** (a destra): cerca per titolo o artista. Con i tasti del brano lo metti come prossimo, lo aggiungi
  in fondo alla coda, oppure lo ascolti in cuffia (preascolto).
- **Jingle istantanei** (12 tasti): un clic lo fa partire sopra la musica. Con la matita assegni il jingle a un tasto.

## 5. Libreria e scheda brano

In **Libreria** trovi l'elenco dei brani. Con **Scheda** apri la scheda brano, dove puoi:

- correggere titolo, interprete, album, anno, genere e tipo;
- inserire **autori/compositori**, **editore** e **codice opera SIAE** (servono per il report SIAE);
- spostare inizio audio, fine audio e punto di mix se l'analisi automatica non ti convince;
- togliere il segno da **Attivo** per escludere un brano da rotazione e ricerca senza cancellarlo.

## 6. Eventi a orario

Scheda **Eventi** → **+ Nuovo evento**. Un evento esegue in ordine una serie di azioni a un orario.

**Quando:**

- **Una volta al giorno**, **Ogni ora** (al minuto scelto) oppure **Ogni N minuti** (da un orario a un altro).
- Giorni della settimana (con le scorciatoie Lun-Ven, Weekend, Tutti) e, se serve, date di inizio e fine validità.

**Come parte:**

- **Dopo il brano**: aspetta che finisca il brano in onda.
- **Dopo il brano, al massimo…**: aspetta, ma se il brano dura troppo lo sfuma dopo i secondi indicati.
- **Subito (sfuma il brano)**: parte all'orario esatto.

**Azioni disponibili:**

| Azione | Cosa fa |
|---|---|
| Brano | un brano preciso |
| Brano casuale | un brano a caso per tipo, genere o cartella (es. un jingle) |
| Playlist | una playlist M3U/PLS o una cartella: subito prima della coda, in fondo, oppure al posto della coda |
| Flusso esterno | un flusso internet (es. un notiziario) per N minuti |
| Automatico / manuale | cambia modalità |
| Svuota coda | toglie i brani in coda |
| Ferma tutto | ferma la messa in onda |
| Regole di rotazione | da quel momento la rotazione usa solo certi generi o anni (es. "dalle 22 musica tranquilla"); "Torna alla rotazione normale" la riporta come prima |
| Comando esterno | avvia un programma o uno script sul PC |

Con **▶ Prova** esegui subito un evento per vedere come va. **Duplica** crea una copia da modificare.
In alto vedi i prossimi eventi in programma e, se attivo, il profilo di rotazione in uso.

## 7. Registro di trasmissione

La scheda **Registro** elenca tutto quello che è andato in onda, con orario, durata, tipo, titolo, interprete,
autori e codice SIAE. Scegli le date e premi **Esporta CSV** (si apre con Excel).
Il registro indica quanti brani non hanno autori o codice SIAE: completali dalla scheda brano.

Il report SIAE nel formato del fac simile arriverà con la fase 7.

## 8. Impostazioni

| Impostazione | Cosa fa |
|---|---|
| Dissolvenza (secondi) | durata della sfumatura quando premi AVANTI |
| Volume obiettivo (LUFS) | volume a cui vengono livellati tutti i brani (-16 è lo standard per lo streaming) |
| Separazione artista / brano (minuti) | tempo minimo prima di ripetere lo stesso artista o lo stesso brano |
| Un jingle ogni … brani | in automatico; 0 = nessun jingle |
| Brani in coda in automatico | quanti brani preparare in anticipo |

Ricordati di premere **Salva**.

## 9. Il server: VM su Proxmox

Serve una volta sola. La guida tecnica completa è in [ponte/README.md](../ponte/README.md).
Sul server girano il ponte, l'Icecast principale e Caddy, che si occupa da solo dell'HTTPS (certificato
Let's Encrypt gratuito, rinnovato in automatico).

1. **Nome di dominio**: serve un nome (per esempio `radio.esempio.it`) che punti all'IP pubblico di casa. Se l'IP
   cambia, usa un DNS dinamico (DuckDNS o quello del router).
2. **Crea la VM**: copia `ponte/proxmox/crea-vm.sh` sul nodo Proxmox ed eseguilo come root.
   Con indirizzo fisso (consigliato):
   `IP=192.168.1.50/24 GATEWAY=192.168.1.1 bash crea-vm.sh`
   Crea una VM Ubuntu 24.04 con 4 core, 4 GB di RAM e 300 GB di disco (servono per la musica), che si avvia insieme a Proxmox.
3. **Installa**: entra nella VM (`ssh radio@192.168.1.50`), copia la cartella `ponte` ed esegui
   `sudo DOMINIO=radio.esempio.it bash installa-server.sh` (con il tuo dominio). Alla fine stampa i valori per
   la regia, la password del pannello e le porte da aprire. Tienili da parte.
4. **Router di casa**: inoltra verso la VM
   - TCP 80 e 443 (HTTPS: pannello, regia, ascolto)
   - TCP 8000 (ascolto senza https, facoltativo)
   - UDP 9000 (audio dalla regia)
   - TCP 9010 (dirette esterne)
   - UDP 40000-40049 (microfono dal pannello e ospiti)
   - UDP 9020 (video da OBS, solo se lo usi da fuori casa)

   Appena le porte 80 e 443 arrivano alla VM, il certificato si attiva da solo.
5. **Musica**: copia la selezione della libreria sul server (sezione 12, "Libreria sul server"). Serve alla
   diretta autonoma e alla musica di riserva.

Se nella VM avevi già installato AzuraCast con la versione precedente, toglilo
(`cd /var/azuracast && sudo ./docker.sh uninstall`) oppure crea una VM nuova: Caddy ha bisogno delle porte 80 e 443.

**Banda di casa:** ogni ascoltatore collegato all'Icecast principale usa 0,128 Mbit/s di upload. Con 20 Mbit/s in
upload ci stanno circa 150 ascoltatori (il massimo si imposta con `ICECAST_MAX_ASCOLTATORI`, di base 1000: con 500 Mbit/s in upload ce ne starebbero quasi 4000).

### Ascolto e Icecast secondario

- Indirizzo per gli ascoltatori (sito, app, lettori): `https://<dominio>/radio.mp3` (MP3 a 128 kbit/s).
  Per i lettori che non usano https: `http://<dominio>:8000/radio.mp3`.
- Titolo in onda e numero di ascoltatori: `https://<dominio>/status-json.xsl`.
- **Icecast secondario**: se hai un Icecast su un altro server, scrivi i suoi dati in `/opt/radio-ponte/.env`
  (`ICECAST_ESTERNO_HOST`, `_PORTA`, `_MOUNT`, `_UTENTE`, `_PASSWORD`) e poi `sudo /opt/radio-ponte/riavvia.sh`.
  Riceve sempre lo stesso segnale del principale, anche la musica di riserva: se il server di casa non è
  raggiungibile, gli ascoltatori passano al secondario e sentono la stessa cosa. Nei lettori che lo permettono,
  mettilo come indirizzo di riserva.

## 10. Collegare la regia al ponte

Scheda **Collegamento** → **Impostazioni del collegamento**:

- **Indirizzo del server**: il nome di dominio della radio (senza `https://`).
- **Porta SRT**, **Frase segreta** e **Token del servizio di controllo**: i valori stampati dall'installazione.
- **Porta del servizio di controllo**: 443, con **"Il servizio di controllo usa HTTPS"** spuntato.
- **Margine contro i buchi di rete**: 2000 ms vanno bene per il 4G. Se l'audio salta, alzalo.
- **Qualità**: 128 kbit/s.
- **Cosa inviare**:
  - *Solo il programma del computer*: musica, jingle ed eventi della regia.
  - *Un ingresso della scheda audio*: per esempio il mix del RodeCaster, così va in onda anche il microfono.
- **Backup automatico**: l'ora del backup giornaliero.
- **Invia artista e titolo agli ascoltatori (Icecast)**: lascialo attivo.

Premi **Salva**, poi **Accendi invio**. In alto compare la spia **PONTE**:

| Spia | Significato |
|---|---|
| verde "OK" | la regia è in onda attraverso il ponte |
| gialla "NON COLLEGATO" | collegamento in corso o caduto: la regia riprova da sola |
| rossa "ALLARMI" | il ponte segnala un problema (vedi scheda Collegamento) |

Quando la regia si scollega, la spia diventa gialla e in onda va la musica di riserva del ponte.

## 11. Dirette esterne

Usa la stessa app di prima (BUTT, Larix, Luci Live…), in modalità Icecast. Cambia solo:

- **server**: il nome di dominio della radio;
- **porta**: 9010;
- **mount**, **utente** e **password**: quelli stampati dall'installazione (`ESTERNA_*` nel file `.env`).

Quando l'app si collega va in onda lei, con una breve dissolvenza. Quando si scollega torna da sola la regia
(o la musica di riserva, se la regia è spenta).
Ricevi una notifica all'inizio e alla fine.

## 12. Pannello remoto e utenti

Il pannello remoto comanda la regia dal browser, da qualsiasi posto: telefono, tablet o computer.

**Aprirlo:** `https://<nome di dominio>` (vedi la sezione 9). La prima volta entra con `admin` e la password
stampata dall'installazione.

**Cosa trovi:**

- in alto la spia **IN ONDA / FERMO**, lo stato della regia (**REGIA OK** o **REGIA SCOLLEGATA**) e il tasto
  **AUTOMATICO / MANUALE**;
- il brano in onda con il tempo mancante (rosso negli ultimi 10 secondi);
- **PLAY**, **AVANTI** e **STOP**, che fanno esattamente quello che fanno in regia;
- la coda, con le frecce per spostare i brani e la ✕ per toglierli;
- la ricerca: ⤒ mette il brano come prossimo, + lo aggiunge in fondo;
- i jingle della cartwall e **Ferma jingle**.

Se compare un allarme del ponte, lo vedi in una striscia rossa in alto.

**Utenti** (menu ☰ → **Utenti**, solo per gli amministratori): scrivi nome, ruolo e password e premi **Salva**.
Per cambiare il ruolo di un utente esistente scrivi il suo nome, scegli il ruolo e lascia vuota la password.
Cambiando la password, l'utente viene scollegato da tutti i dispositivi.

| Ruolo | Cosa può fare |
|---|---|
| Amministratore | tutto, compresa la gestione degli utenti e delle chiavi di YouTube e Facebook |
| Conduttore | comandare la regia, microfono, ospiti, diretta autonoma, dirette video |
| Ospite | vedere cosa va in onda e cercare nella libreria, senza comandare |

**Nella regia** (scheda **Collegamento**) l'opzione "Permetti di comandare la regia dal pannello remoto" è
attiva di base. La riga "Pannello remoto" dice se il collegamento è attivo e mostra l'indirizzo del pannello.

Dopo 5 password sbagliate di fila dallo stesso indirizzo, il pannello blocca i tentativi per un minuto.

### Microfono dal pannello

Conduttori e amministratori possono parlare in diretta dal pannello, da casa o da fuori, senza passare dal
PC della regia. La voce va nel mixer del ponte insieme al programma della regia (o della diretta esterna).

1. Collega le **cuffie** e premi **🎙 Apri microfono**. Il browser chiede il permesso di usare il microfono:
   rispondi sì. Da questo momento in cuffia senti il programma, quasi senza ritardo, ma la tua voce
   **non è ancora in onda**. La barra mostra il livello del microfono: verde va bene, gialla è forte, rossa
   è troppo forte.
2. Premi **VAI IN ONDA**: la musica si abbassa (di 12 dB, regolabile) e la tua voce va in onda. Il tasto
   diventa rosso con la scritta **IN ONDA**. In cuffia continui a sentire il programma, senza la tua voce
   (così non senti l'eco).
3. Premi di nuovo il tasto rosso per uscire dall'onda: la musica torna su. **Chiudi microfono** spegne tutto.

Cose utili da sapere:

- funziona **solo con il pannello in HTTPS** (`https://<nome di dominio>`, vedi la sezione 9): i browser
  non danno il microfono alle pagine non protette;
- un solo microfono remoto alla volta: chi lo apre per secondo vede chi lo sta usando;
- se la connessione cade o chiudi la pagina, il microfono esce dall'onda da solo;
- la voce va in onda solo se c'è un programma: regia, diretta esterna o diretta autonoma (non sopra la musica di
  riserva). Con la regia spenta avvia la **diretta autonoma** (qui sotto) e parla sopra la musica del server;
- **Uso le cuffie**: lascialo spuntato. Senza cuffie toglilo prima di aprire il microfono: il browser
  attiva la riduzione dell'eco e del rumore, ma la voce suona meno naturale;
- **Ritorno**: volume del programma in cuffia.

### Ospiti in diretta

Puoi far parlare in diretta fino a **3 ospiti** collegati da casa, con il telefono o il computer, senza
installare nulla. Serve il pannello in HTTPS, come per il microfono.

1. Nel pannello, sezione **Ospiti**, scrivi per chi è il link (per esempio "Mario, intervista delle 18") e premi
   **Crea link**. Premi **Copia** (o **Invia…** dal telefono) e mandalo all'ospite, per esempio su WhatsApp.
   Il link vale 24 ore; da **Link attivi** puoi copiarlo di nuovo o **Revocarlo**.
2. L'ospite apre il link, scrive il nome, prova il microfono (la barra deve muoversi) e preme
   **Entra in sala d'attesa**. Intanto sente la radio.
3. Nel pannello compare l'ospite "in sala d'attesa": premi **Fai entrare** (o **Rifiuta**).
4. Quando l'audio è collegato, premi **Metti in onda**: la musica si abbassa e l'ospite va in onda. Sulla sua pagina
   compare **IN ONDA** in rosso. Premi di nuovo per toglierlo dall'onda, **Chiudi** per salutarlo.

In cuffia ognuno sente la radio e le altre voci in onda (tu, gli altri ospiti), ma non la propria. Consiglia
all'ospite di usare le **cuffie**: senza, deve togliere la spunta "Uso le cuffie" prima di entrare.
Se l'ospite chiude la pagina o perde la connessione esce dall'onda da solo; riaprendo lo stesso link torna in
sala d'attesa.

### Diretta autonoma dal server

Serve quando vuoi andare in onda senza la regia, per esempio da fuori con il telefono: il ponte suona la musica
che ha sul server, e tu puoi parlarci sopra con il microfono del pannello.

- **▶ Avvia diretta autonoma**: la musica del server va in onda **al posto della regia** (la regia può restare
  accesa, ma non si sente). Se si collega una diretta esterna, ha la precedenza.
- **Cerca nella libreria del server**: ⤒ mette il brano come prossimo, + lo aggiunge in fondo. Con la coda vuota il
  ponte sceglie da solo, senza ripetere troppo presto lo stesso brano o lo stesso artista.
- **⬆ Carica brani dal dispositivo**: scegli uno o più file dal telefono o dal computer; vengono caricati sul
  server e messi in coda.
- **⏭ Salta** passa al brano successivo; **■ Ferma e torna alla regia** chiude la diretta autonoma.

Il brano successivo si decide circa 20 secondi prima della fine di quello in onda: fino ad allora puoi cambiare la
coda. Tra un brano e l'altro non c'è dissolvenza. Inizio e fine della diretta autonoma arrivano come notifica.
Gli ospiti del pannello vedono cosa suona ma non la comandano.

### Libreria sul server

Nella regia, scheda **Collegamento**, sezione **Libreria sul server**. Sul server va solo una selezione:

- niente **live** (parola "live" o "dal vivo" nel genere, nella cartella, oppure nel titolo come "(Live)",
  "- Live at…"; titoli come "Live Forever" restano dentro);
- niente **interviste** ("intervista" nel titolo, nel genere o nella cartella);
- niente file sotto i **192 kbps** (modificabile).

Con **Scegli a mano** vedi gli esclusi con il motivo e puoi premere **Includi comunque**; con "Tutta la musica"
cerchi un brano e lo puoi **Escludere**. **Lascia decidere alla regola** annulla la scelta a mano.

**Prima copia (a mano, circa 100 GB):**

1. Collega un disco USB alla regia e premi **Copia la selezione su disco…**, scegliendo il disco. Copia solo i brani
   della selezione, già nelle cartelle giuste. Se la interrompi, alla ripartenza salta quelli già copiati.
2. Porta il disco a casa, collegalo al server (in Proxmox: passa il disco USB alla VM) ed esegui nella VM:
   `sudo rsync -a --info=progress2 /media/<disco>/regia/ /opt/radio-ponte/musica/regia/` e poi
   `sudo chown -R 1000:1000 /opt/radio-ponte/musica`.

La stessa libreria serve anche alla **musica di riserva**, che il ponte suona da solo quando non c'è nessuna
diretta. I brani sotto i 60 secondi (jingle, spot) non vengono scelti.

**Dopo:** la regia invia da sola via internet solo i brani **nuovi o cambiati**, e toglie dal server quelli usciti
dalla selezione. Lo fa **di notte** (di base dalle 1 alle 6) e al massimo **1 GB al giorno**, perché il 4G non è
illimitato: puoi cambiare ore e limite nella stessa sezione (poi **Salva**). **Invia ora i brani nuovi** parte
subito, ma rispetta il limite del giorno. Ogni giorno manda anche al server i titoli corretti e il volume misurato.
Se un giorno la regia vedesse sparire troppi brani (per esempio il disco della musica scollegato), si ferma e non
toglie nulla dal server.

### Dirette video su YouTube e Facebook

YouTube e Facebook vogliono un video: dal pannello, sezione **Dirette video**, mandi la radio con un'immagine.

**Una volta sola (amministratore):** apri **Impostazioni (chiavi delle dirette, ritardo)** e incolla la chiave
di YouTube (YouTube Studio → Trasmetti dal vivo → chiave dello stream) e/o di Facebook (Live Producer → chiave
di streaming), poi **Salva**. Le chiavi restano sul server: nel pannello non si vedono più. Per cambiarne una,
incolla quella nuova; un campo lasciato vuoto non cambia la chiave salvata.

**Immagine:**

- **Logo fisso**: carica un'immagine PNG o JPEG (ideale 1280×720) con **⬆ Carica il logo**. Il server la
  trasmette a 720p, quasi senza fatica.
- **Video da OBS**: la webcam (o altro) la gestisci in OBS, fuori dal programma. In OBS, Impostazioni →
  Stream: Servizio **Personalizzato**, Server `srt://<dominio>:9020` (in casa basta l'IP della VM), chiave
  vuota. Uscita: codificatore **x264**, risoluzione **1280×720** al massimo, fotogrammi chiave ogni **2 s**,
  2500-4000 kbit/s. Il pannello mostra l'indirizzo esatto quando scegli "Video da OBS". Il ponte inoltra il
  video così com'è, senza ricodificarlo; se OBS manda più di 720p si ferma e te lo dice.

**Andare in onda:** scegli l'immagine, spunta **YouTube** e/o **Facebook** e premi **▶ Avvia diretta video**.
Con OBS, dopo, premi "Avvia trasmissione" in OBS. Quando parte, il riquadro dice **IN ONDA**. **■ Ferma diretta
video** la chiude. L'audio è sempre quello della radio. Se il video di OBS e l'audio non sono allineati, regola
il **ritardo** nelle impostazioni (in millisecondi: positivo ritarda l'audio, negativo il video).

Se la diretta cade, il ponte riprova da solo e ti manda una notifica; se non riesce a ripartire si ferma.
Su YouTube e Facebook la diretta va comunque creata o programmata come sempre: il ponte manda solo il segnale.

## 13. Allarmi e notifiche

Il ponte avvisa via Telegram e/o email (da configurare nel `.env` del server; la scheda **Collegamento** ha
**Invia notifica di prova**):

- regia scollegata dal ponte;
- programma della regia che non risponde (PC spento, app chiusa);
- silenzio in onda;
- collegamento instabile (troppe riconnessioni);
- errori verso l'Icecast principale o il secondario;
- diretta video interrotta o che non riesce a ripartire;
- inizio e fine di una diretta esterna;
- avvio e fine della diretta autonoma, con il nome di chi l'ha comandata.

Quando il problema si risolve arriva un secondo messaggio. Gli allarmi attivi si vedono anche nella scheda Collegamento.

## 14. Backup e ripristino

Ogni giorno, all'ora scelta, la regia salva sul ponte una copia di libreria, eventi, registro e impostazioni.
Il ponte tiene gli ultimi 14.

- **Fai un backup adesso**: copia immediata, utile prima di grandi modifiche.
- **Mostra i backup sul ponte** → **Ripristina** → **Sì, ripristina**: la regia si riavvia con il backup scelto.
  La messa in onda si ferma per qualche secondo. Il database di prima resta in una copia a parte.

## 15. Problemi comuni

| Problema | Cosa controllare |
|---|---|
| "Il ponte non risponde" | porta UDP 9000 non inoltrata sul router, indirizzo sbagliato, VM spenta |
| "Frase segreta errata" | la frase segreta della regia è diversa da quella del `.env` |
| "token del ponte errato" | il token della regia è diverso da quello del `.env` |
| Allarme Icecast secondario | host, porta, mount o password `ICECAST_ESTERNO_*` sbagliati, oppure server esterno spento |
| Il pannello non si apre in https | il dominio non punta all'IP di casa, o le porte 80/443 non arrivano alla VM (`docker compose logs caddy`) |
| La scheda audio scelta non è disponibile | il RodeCaster è scollegato o spento |
| L'app delle esterne non si collega | porta 9010 non inoltrata, oppure mount/utente/password diversi |
| Il pannello dice REGIA SCOLLEGATA | regia spenta o senza internet, oppure "Permetti di comandare la regia dal pannello remoto" disattivato |
| Il pannello non si apre | porte 80 e 443 non inoltrate verso la VM |
| "Il microfono funziona solo con il pannello aperto in HTTPS" | apri il pannello con `https://` e il nome di dominio (sezione 9) |
| Il microfono si apre ma non si sente nulla, oppure si chiude dopo 20 secondi | porte UDP 40000-40049 non inoltrate sul router verso la VM |
| "la libreria del server è vuota" | fai la prima copia della selezione (sezione 12, Libreria sul server) o carica brani dal pannello |
| "la selezione toglierebbe … brani dal server" | il disco o la cartella della musica della regia non è collegato: ricollegalo e riprova |
| La regia non invia brani al server | fuori dalle ore di invio, limite del giorno raggiunto, oppure "Invia da solo" spento |
| L'ospite dice "Link non valido o scaduto" | il link ha più di 24 ore o è stato revocato: creane uno nuovo |
| L'ospite entra ma non si sente / "si sta collegando…" resta fermo | porte UDP 40000-40049 non inoltrate, oppure la rete dell'ospite blocca l'audio: prova con un'altra rete (per esempio dati del telefono) |
| "Permesso del microfono negato dal browser" | nelle impostazioni del sito nel browser consenti il microfono, poi ricarica la pagina |
| Diretta video "in attesa del video da OBS" | OBS non è in trasmissione, oppure non raggiunge la porta UDP 9020 (indirizzo o frase segreta) |
| "OBS manda 1920x1080" | in OBS, Impostazioni → Video: risoluzione di uscita 1280×720 |
| "manca la chiave di YouTube/Facebook" | un amministratore deve inserirla nelle impostazioni delle dirette video |

## 16. In arrivo

Prossime fasi (l'ordine può cambiare):

- statistiche degli ascoltatori lette dagli Icecast (principale e secondario);
- FluidStream, se un giorno servirà;
- analisi della libreria stile MusicBrainz, report SIAE nel formato del fac simile e riconoscimento dei brani in onda (anche nelle esterne);
- registrazione della messa in onda e podcast, download automatico di notiziari, voce sintetica;
- rotazioni generate dall'AI a partire da una descrizione del palinsesto.

## 17. Modifiche alla guida

| Data | Novità |
|---|---|
| 14/11/2026 | Prima versione: regia (fase 1), eventi avanzati, ponte, collegamento, backup, dirette esterne, VM Proxmox |
| 15/11/2026 | Pannello remoto dal browser, utenti con ruoli, HTTPS con il certificato di AzuraCast, `riavvia.sh` |
| 15/11/2026 | Microfono dal pannello remoto: voce in onda con la musica che si abbassa, ritorno in cuffia; nuova porta UDP 40000-40049 |
| 15/11/2026 | Diretta autonoma dal server (dal pannello), libreria sul server con selezione automatica, copia su disco USB e invio notturno; disco della VM a 300 GB |
| 15/11/2026 | Ospiti in diretta con un link: sala d'attesa, fai entrare, in onda, fino a 3 insieme, ritorno in cuffia per tutti |
| 15/11/2026 | Server senza AzuraCast: Icecast principale e HTTPS automatico (Caddy) nella stessa VM; regia sulla porta 443; Icecast secondario con lo stesso segnale; musica di riserva quando nessuno è in diretta; dirette video su YouTube e Facebook (logo o OBS, massimo 720p) |
