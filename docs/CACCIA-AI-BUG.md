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
