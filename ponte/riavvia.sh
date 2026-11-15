#!/usr/bin/env bash
# Riavvia (e aggiorna) il ponte. Se AzuraCast sullo stesso server ha un certificato Let's Encrypt,
# il pannello remoto e il servizio di controllo passano da soli a HTTPS con lo stesso certificato.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
COMPOSE=(-f docker-compose.yml)
if docker volume inspect azuracast_acme >/dev/null 2>&1 \
  && docker run --rm -v azuracast_acme:/acme:ro alpine sh -c 'test -s /acme/acme.crt || test -s /acme/custom.crt' 2>/dev/null; then
  COMPOSE+=(-f docker-compose.https.yml)
  echo "# https attivo" > .stato-https
  echo "Certificato di AzuraCast trovato: il pannello usa HTTPS."
else
  echo "# https non attivo" > .stato-https
  echo "Nessun certificato Let's Encrypt in AzuraCast: il pannello usa HTTP."
fi
docker compose "${COMPOSE[@]}" up -d --build "$@"
