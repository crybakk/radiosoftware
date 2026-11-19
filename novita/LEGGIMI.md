# Novità delle versioni

Ogni modifica che cambia qualcosa per chi usa la regia o il server aggiunge **un file nuovo** in questa cartella
(es. `novita/2026-11-19-novita-aggiornamenti.md`), con le sezioni `## Regia` e/o `## Server` e un elenco di punti
scritti in italiano semplice, per chi usa il programma (non per i programmatori):

```markdown
## Regia

- Quando installi un aggiornamento la regia ti dice cosa è cambiato.

## Server

- Il pannello mostra le novità prima e dopo l'aggiornamento del server.
```

Alla pubblicazione automatica della release (`.github/workflows/release.yml`) `scripts/note-release.mjs` raccoglie i
file aggiunti dopo la release precedente e scrive la descrizione della release. Regia e pannello la leggono:

- mostrano l'elenco delle novità prima di aggiornare ("Cosa cambia?") e dopo l'aggiornamento ("Ecco cosa è cambiato");
- se una versione cambia solo il server, la regia non propone di aggiornarsi (e viceversa).

Quale programma cambia si capisce da solo dai file modificati (`src/` = regia, `ponte/` = server; prove e
documentazione non contano). Una sezione `## Regia` o `## Server` nel file di novità segna quel programma come
cambiato anche se il codice non lo è (es. una guida rifatta da far arrivare subito).

Un file per modifica (invece di un unico elenco) evita i conflitti tra modifiche fatte in parallelo. I file non si
cancellano: restano come storia.
