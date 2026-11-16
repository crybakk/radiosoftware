# Caccia ai bug – 15/11/2026

Cinque agenti hanno analizzato il codice di main (commit 897e1b0), ognuno su un'area, provando sia l'uso corretto sia l'uso sbagliato o malevolo. Quasi tutti i bug sono stati dimostrati con un test che falliva; i test ora sono diventati test di regressione e passano.

Legenda: ✅ corretto in questa PR · ❓ serve una tua decisione · ⏸ lasciato com'è (motivo indicato)

## Critici

| # | Area | Problema | Stato |
|---|---|---|---|
| 1 | Ponte | Chiunque su internet, senza password, poteva far crollare il server ponte con una sola richiesta: indirizzo `//`, messaggio `null` sul canale regia, cookie malformato o cookie `constructor`. Docker lo riavvia, ma ogni volta cadono regia, pannello e allarmi. | ✅ |

## Alti

| # | Area | Problema | Stato |
|---|---|---|---|
| 2 | Playout | Un brano non ancora analizzato (durata 0) in AUTOMATICO faceva partire un brano nuovo ogni 200 ms, tutti sovrapposti. Ora si aspetta la fine reale del file. | ✅ |
| 3 | Playout | STOP non fermava se in coda c'era un brano di un evento: a fine sfumatura ripartiva. | ✅ |
| 4 | Playout | STOP premuto mentre il brano successivo stava caricando (rete lenta, flusso): il brano andava in onda lo stesso. Ora resta in testa alla coda. | ✅ |
| 5 | Playout | La tolleranza di un evento soft restava attiva e tagliava più tardi un altro brano (anche dopo "svuota coda"). | ✅ |
| 6 | Ponte | Un conduttore declassato a ospite (senza cambio password) manteneva i comandi finché restava collegato. Ora il ruolo è ricontrollato a ogni comando e il pannello si ricollega col ruolo nuovo. | ✅ |
| 7 | Libreria | "Aggiorna libreria" rimetteva in rotazione i brani disattivati a mano e azzerava il tipo scelto a mano (es. jingle). | ✅ |
| 8 | Libreria | Con NAS o disco spento durante "Aggiorna libreria" venivano disattivati tutti i suoi brani: rotazione a secco. | ✅ |
| 9 | Libreria | Togliere una cartella dalla libreria lasciava i suoi brani in ricerca e in rotazione. | ✅ |
| 10 | Interfaccia | Cancellare una data nel Registro faceva crollare l'interfaccia e fermava l'automazione (silenzio dopo il brano in onda). Ora la data vuota è ignorata e ogni scheda ha una protezione: un errore mostra un avviso con "Riprova" senza fermare la regia. | ✅ |
| 11 | Audio | Un file o un flusso che non risponde bloccava il playout per sempre. Ora dopo 15 s passa al successivo. | ✅ |

## Medi

| # | Area | Problema | Stato |
|---|---|---|---|
| 12 | Registro SIAE | Il brano in onda alla chiusura (o a un crash) risultava di 0 secondi. Ora si calcola la durata reale, al massimo la durata del brano. | ✅ |
| 13 | Ponte | Logout e sessioni scadute non chiudevano il pannello già aperto. | ✅ |
| 14 | Ponte | Il limite di 5 tentativi di accesso al minuto si poteva aggirare con richieste parallele; il controllo password bloccava il server. | ✅ |
| 15 | Connessione | Con il 4G "morto" (senza disconnessione pulita) la regia restava "collegata" anche per molti minuti. Ora il ponte manda un segnale ogni 15 s e la regia si ricollega dopo 40 s di silenzio (compatibile con un ponte vecchio). | ✅ |
| 16 | Connessione | Cattura audio per il ponte avviata due volte (cambio ingresso rapido): audio doppio e confuso in onda; spegnere l'invio durante l'avvio non lo fermava. | ✅ |
| 17 | Connessione | Indirizzo del ponte con la barra finale (`ponte.it/`): comandi ok ma audio SRT mai collegato. Ora l'indirizzo è normalizzato; `host:porta` senza schema viene rifiutato con un messaggio chiaro. | ✅ |
| 18 | Eventi | Il giorno del passaggio all'ora legale un evento orario partiva due volte alle 3. | ✅ |
| 19 | Eventi | Se l'orologio del PC tornava indietro gli eventi già eseguiti ripartivano. | ✅ |
| 20 | Eventi | Un evento "ogni N minuti" che passa la mezzanotte veniva salvato ma non partiva mai. Ora l'editor lo rifiuta con un messaggio. | ✅ |
| 21 | Libreria | File vuoti o non audio con estensione .mp3 entravano in rotazione. | ✅ |
| 22 | Libreria | Analisi ffmpeg senza limite di tempo: un file bloccato fermava l'analisi di tutta la libreria; "Ferma" non la interrompeva. | ✅ |
| 23 | Avvio | Aprire l'app due volte poteva avviare database e ponte anche nella seconda copia. | ✅ |
| 24 | Ricerca | "città" non trovava "CITTÀ". | ✅ |
| 25 | Riavvio | Dopo riavvio o blackout la regia riparte in MANUALE con coda vuota: silenzio. | ❓ |
| 26 | Ponte (config) | `riavvia.sh` controlla certificati con nomi diversi da quelli che usa il server: si può finire in HTTP senza accorgersene. Va verificato sul server vero. | ❓ |
| 27 | Libreria | Se un file cambia, titolo/artista/cue corretti a mano vengono sovrascritti dai tag. | ⏸ serve decidere quali campi proteggere |

## Bassi

| # | Area | Problema | Stato |
|---|---|---|---|
| 28 | Registro | Nome del file esportato con la data di un giorno prima. | ✅ |
| 29 | Impostazioni | Svuotare un campo numerico salvava un valore estremo (es. −9 LUFS). | ✅ |
| 30 | Connessione | Comandi remoti eseguiti fuori ordine (es. "metti come prossimo" + "avanti"). | ✅ |
| 31 | Connessione | Conto alla rovescia del nuovo tentativo bloccato nella schermata. | ✅ |
| 32 | Ponte | Backup: errore durante il download faceva cadere il server; due backup nello stesso secondo si rovinavano. | ✅ (il secondo ora sostituisce il primo, ma intatto) |
| 33 | Modalità MANUALE | La guida dice che a fine brano parte il successivo, il programma si ferma. | ❓ |
| 34 | Jingle | Doppio clic: il jingle suona due volte sovrapposto. | ❓ |
| 35 | Ricerca | "citta" senza accento non trova "città". | ❓ |
| 36 | Eventi | Il giorno del ritorno all'ora solare un evento orario parte 24 volte invece di 25. | ⏸ |
| 37 | Registro | Esportazione CSV: un titolo che inizia con `=` viene interpretato da Excel come formula. | ⏸ |
| 38 | Connessione | Comando ripetuto dopo una caduta di linea può essere eseguito due volte. | ⏸ |
| 39 | Ponte (config) | Il servizio di controllo riceve tutte le password del file `.env`, anche quelle che non gli servono. | ⏸ |
| 40 | Interfaccia | Clic fuori dall'editor eventi lo chiude perdendo le modifiche; "Elimina" evento senza conferma; durate oltre l'ora mostrate come "120:05". | ⏸ |
| 41 | Audio | Staccare il RodeCaster durante la diretta non mostra avvisi. | ⏸ da provare sull'hardware |

## Note sulla migrazione del database

Le tabelle dei brani ricevono due colonne nuove (`missing`, `kind_manual`), aggiunte in automatico all'avvio. I brani già disattivati prima dell'aggiornamento vengono considerati disattivati a mano: se uno era disattivato solo perché il file mancava, va riattivato a mano una volta.

---

# Seconda caccia ai bug – 15-16/11/2026

Cinque agenti hanno analizzato il codice delle fasi 4b-8 (diretta autonoma, ospiti, video, SIAE, riconoscimento, programmi e podcast, ascoltatori, bot Telegram) e lo hanno corretto, con un test per ogni bug dove possibile. Test totali: 254, tutti verdi.

## Corretti – i più gravi

| Area | Problema |
|---|---|
| Programmi | Nei giorni del cambio d'ora le registrazioni partivano un'ora dopo (una fascia delle 21 registrava dalle 22). |
| Programmi | Due fasce attaccate dello stesso programma tagliavano la registrazione; una fascia a mezzanotte perdeva il margine. |
| Programmi / podcast | ffmpeg mancante, disco pieno o un file di puntata sparito mentre qualcuno ascolta facevano cadere il server. Una pubblicazione poteva restare in attesa per sempre o partire due volte. |
| Microfono e ospiti | Se un ospite cadeva (4G) proprio mentre lo si metteva in onda, la voce restava aperta nel mixer e la musica restava abbassata. |
| Microfono e ospiti | Due richieste di collegamento ravvicinate lasciavano connessioni audio aperte, fino a esaurire le porte; comandi "in onda/fuori onda" potevano arrivare al mixer in ordine sbagliato. |
| Ospiti | Con un link d'invito si potevano aprire connessioni senza limite (ora massimo 10 per indirizzo); il file degli inviti era leggibile da tutti sul server. |
| Dirette video | Le chiavi di YouTube/Facebook comparivano negli errori visibili a tutti i ruoli, anche agli ospiti, e negli avvisi. |
| Dirette video | ffmpeg che non parte faceva cadere il server; una diretta che cadeva dopo pochi secondi ripartiva all'infinito mandando un avviso ogni volta; dopo "stop" ffmpeg poteva restare acceso. |
| Riconoscimento | Durante le esterne, ffmpeg mancante o un errore nel riconoscimento facevano cadere il server. Dopo molti aggiornamenti delle impronte l'indice si riempiva e ogni ricerca falliva (quindi il server cadeva a ogni esterna). |
| SIAE | I passaggi di brani etichettati giorni dopo non arrivavano mai nel report. Una sola data rovinata nel registro del server bloccava per sempre l'importazione in regia. |
| MusicBrainz | Due ricerche insieme superavano il limite di 1 richiesta al secondo. |
| Bot Telegram | In caso di errore di rete il token del bot finiva nei log. |
| Diretta autonoma | Un brano in coda tolto dalla libreria bloccava la diretta autonoma in silenzio; un doppio clic su "avvia" mandava due brani. |
| Libreria sul server | Un file rifiutato dal server (o oltre 300 MB) bloccava per sempre l'invio notturno di tutti gli altri. I brani caricati dal pannello venivano cancellati dal server la notte dopo. Due cartelle con lo stesso nome si sovrascrivevano. Un file caricato durante la scansione spariva dall'indice. |
| Libreria sul server | Gli invii interrotti dal 4G non contavano nel limite giornaliero (rischio di consumare traffico tutta la notte); il backup automatico fallito veniva ritentato ogni 15 secondi, tutto il giorno. |
| Server | Ogni richiesta veniva chiusa dopo 5 minuti: backup e caricamenti grandi via 4G fallivano sempre. Ora fino a 3 ore. File troppo grandi ricevono un messaggio chiaro invece di una connessione chiusa. |
| Server | Dopo ogni riavvio del servizio di controllo partiva un falso allarme "regia scollegata". Durante le esterne e la diretta autonoma il titolo in onda pubblico mostrava i brani della regia, che nessuno sentiva. |
| Pannello | Dopo un cambio di ruolo il pannello non si aggiornava (un admin declassato vedeva ancora "Utenti"). |
| Regia | Nomi di file riservati di Windows (CON, NUL…) per i brani scaricati dal server. |

Più una ventina di problemi minori (errori non gestiti, file temporanei rimasti, pagine pubbliche con indirizzi malformati, ecc.).

## Da decidere (non corretti)

1. **Ospiti e bozze:** un ospite può vedere e ascoltare le bozze delle puntate e le registrazioni in corso. Consiglio: solo conduttore e admin.
2. **Link d'invito riutilizzabili:** un link vale per più persone e resta valido dopo "caccia". Consiglio: un ospite per link, oppure "caccia" annulla il link.
3. **Ospite (ruolo del pannello):** vede elenco ospiti e clip dei brani sconosciuti. Va bene?
4. **Spazio su disco del server:** nessun controllo prima di registrare o di accettare caricamenti; le bozze non scadono mai. Consiglio: rifiutare e avvisare sotto una soglia di spazio libero.
5. **SIAE, doppio conteggio:** se il 4G cade e la regia continua a suonare mentre il server manda la riserva, la stessa fascia viene contata due volte. Consiglio: in quei periodi contare solo il server.
6. **SIAE, riserva e diretta autonoma:** un brano interrotto dopo 5 secondi conta lo stesso (in regia sotto i 30 s non conta).
7. **Autori separati da virgola:** un tag "Rossi, Vasco" diventa due autori.
8. **Bot Telegram:** il pulsante "Non è musica" resta anche dopo l'etichetta, e chiunque nella chat può cancellare un brano già etichettato.
9. **MusicBrainz:** chiede un contatto (sito o email) nell'identificativo dell'app, altrimenti può rallentarci. Quale mettiamo?
10. **Cancellazioni sul server:** la protezione scatta solo oltre 50 file *e* oltre il 20%: un disco scollegato in regia può far cancellare fino a 50 brani dal server (o fino al 20% di una libreria grande). Consiglio: non cancellare mai i brani solo temporaneamente mancanti e abbassare la soglia.
11. **Icecast:** la pagina di amministrazione è raggiungibile in chiaro sulla porta 8000 e la password del relay è uguale a quella di amministrazione. Consiglio: servirla solo tramite Caddy (HTTPS) e usare password diverse.
12. **Dirette video da OBS:** ora dopo 5 cadute ravvicinate la diretta si ferma con un errore invece di riprovare per sempre.
13. **Crash durante una registrazione:** la bozza risulta di durata 0 e, se il servizio riparte dentro la fascia, nasce una seconda puntata.

---

# Terzo giro – 16/11/2026: punti aperti sistemati

cristian ha chiesto di sistemare tutto: i punti "da decidere" sono stati risolti con le soluzioni consigliate, e il codice arrivato nella notte (notiziari, voce sintetica, rotazioni con l'AI) è stato controllato.

## Scelte applicate

| Punto | Come è stato sistemato |
|---|---|
| Modalità MANUALE | Il programma resta com'era (a fine brano si ferma): corretta la guida. In manuale la coda non mostra più orari previsti. |
| Riavvio o blackout | Se la regia era in AUTOMATICO, riparte da sola in AUTOMATICO e riprende a suonare. Se era in MANUALE resta in manuale. |
| Doppio clic su un jingle | Il secondo clic viene ignorato finché il jingle suona. |
| Ricerca | Ignora anche gli accenti: "citta" trova "città" e "CITTÀ". |
| Correzioni a mano | Titolo, artista, album, anno, genere e punti di mix modificati a mano non vengono più sovrascritti se il file cambia. |
| Bozze delle puntate | Il ruolo ospite del pannello non vede e non ascolta più bozze e registrazioni in corso. |
| Link d'invito | "Chiudi" su un ospite annulla anche il suo link. Attenzione: vale anche per un normale saluto a fine intervento, quindi per un nuovo collegamento serve un link nuovo. |
| Pagina dell'ospite | Se l'audio non si collega riprova da sola; con la sala piena la connessione si chiude. |
| Spazio su disco del server | Sotto 2 GB liberi (impostabile con SPAZIO_MINIMO_MB) non partono registrazioni, i caricamenti vengono rifiutati e arriva un allarme. |
| Crash durante una registrazione | Al riavvio la bozza prende la durata vera; se si è ancora dentro la fascia, la registrazione continua nella stessa puntata. |
| File di stato rovinati | Prima di riscriverli vengono messi da parte (`.rovinato-…`). |
| Bot Telegram | "Non è musica" non è più possibile su un brano già etichettato. |
| SIAE, riserva e diretta autonoma | Il registro del server segna i secondi davvero trasmessi; sotto i 30 secondi non conta, come in regia. |
| SIAE, doppio conteggio | I passaggi della regia sovrapposti alla riserva o alla diretta autonoma del server non vengono contati. |
| Cancellazioni sul server | I brani mancanti solo per poco (disco o NAS scollegato) non vengono mai cancellati dal server. Oltre 20 cancellazioni in una volta serve il tasto "Conferma cancellazioni". |
| Icecast | L'amministrazione è raggiungibile solo in HTTPS (https://DOMINIO/admin/); gli indirizzi di ascolto restano gli stessi. La password dei relay ora è separata e viene creata da riavvia.sh. **Da verificare sul server dopo l'aggiornamento.** |
| Rotazioni con l'AI | Nuovo tasto "Interrompi" durante la generazione. |

## Controllo del codice nuovo (16 correzioni)

- **Notiziari:**
  - download senza limiti che riempivano memoria e disco;
  - un feed malformato poteva bloccare il programma;
  - una pagina web (per esempio il login del Wi-Fi) poteva andare in onda come notiziario;
  - la pulizia di una fonte cancellava i notiziari di un'altra con nome simile;
  - un notiziario vecchio poteva andare in onda come nuovo.
- **Eventi:** un notiziario o un annuncio lento non blocca più l'evento oltre 3 minuti.
- **Voce sintetica:**
  - due annunci uguali insieme si rovinavano a vicenda;
  - una sintesi bloccata restava ferma per sempre;
  - una voce installata a metà risultava installata;
  - un titolo lunghissimo faceva saltare l'annuncio;
  - un annuncio a orario fisso partiva due volte il giorno del ritorno all'ora solare.
- **Rotazioni con l'AI:**
  - i tag dei brani potevano manipolare le istruzioni date all'AI;
  - una generazione poteva restare "in corso" per sempre;
  - una pagina d'errore scaricata poteva essere presa per il modello.

## Ancora aperto

- **Contatto per MusicBrainz:** chiede un sito o un'email nell'identificativo dell'app. Quale mettiamo?
- **Esportazione CSV per la SIAE:** un titolo che inizia con `=` verrebbe letto da Excel come formula. Non è stato toccato per non alterare i dati inviati alla SIAE.
- **Ritorno all'ora solare:** un evento orario parte 24 volte invece di 25.
- **Autori nei tag:** un tag "Rossi, Vasco" diventa due autori, perché la virgola separa gli autori come hai scelto per la SIAE.
- **Ruolo ospite del pannello:** vede ancora l'elenco degli ospiti e le clip dei brani sconosciuti.
- **Guasto della voce sintetica o del modello AI:** può ancora far cadere il server o la regia. Per evitarlo bisognerebbe farli girare in un processo separato, che è un lavoro più grande.
- **Annunci delle 2 di notte:** il giorno del passaggio all'ora legale non partono.
