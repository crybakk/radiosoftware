#!/usr/bin/env bash
# Riavvia (e aggiorna) il server della radio: ponte, Icecast principale e Caddy (HTTPS automatico).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# libreria musicale del server (diretta autonoma e musica di riserva): scrivibile dal servizio di controllo (utente 1000)
mkdir -p musica richieste
chown 1000:1000 musica richieste 2>/dev/null || true
# il pannello modifica le impostazioni: il file .env deve essere scrivibile dal servizio di controllo (resta privato)
chown 1000:1000 .env 2>/dev/null || true
chmod 600 .env 2>/dev/null || true
docker compose up -d --build --remove-orphans "$@"
