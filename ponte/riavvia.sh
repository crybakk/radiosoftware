#!/usr/bin/env bash
# Riavvia (e aggiorna) il server della radio: ponte, Icecast principale e Caddy (HTTPS automatico).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# libreria musicale del server (diretta autonoma e musica di riserva): scrivibile dal servizio di controllo (utente 1000)
mkdir -p musica richieste
chown 1000:1000 musica richieste 2>/dev/null || true
# password del relay di Icecast: propria, non più uguale a quella di amministrazione (installazioni vecchie)
if [[ -f .env ]] && ! grep -q '^ICECAST_PASSWORD_RELAY=.' .env; then
  sed -i '/^ICECAST_PASSWORD_RELAY=/d' .env
  echo "ICECAST_PASSWORD_RELAY=$(openssl rand -hex 12)" >> .env
fi
# il pannello modifica le impostazioni: il file .env deve essere scrivibile dal servizio di controllo (resta privato)
chown 1000:1000 .env 2>/dev/null || true
chmod 600 .env 2>/dev/null || true
# guida d'uso per il pannello (la riempie installa-server.sh)
mkdir -p guida
docker compose up -d --build --remove-orphans "$@"
