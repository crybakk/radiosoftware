#!/usr/bin/env bash
# Applica le impostazioni salvate dal pannello: "docker compose up -d" riavvia solo le parti
# del server con valori cambiati. Lo lancia il servizio radio-ponte-impostazioni quando il pannello
# lascia la richiesta richieste/applica. Scrive l'esito in richieste/esito.json per il pannello.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
rm -f richieste/applica
# .env e richieste/ sono scrivibili dal servizio di controllo: qui (come root) non ci fidiamo di loro.
# Il file di compose è sempre quello del progetto e nel .env non devono comparire variabili COMPOSE_*,
# che cambierebbero i file o il progetto usati da docker compose.
if grep -qE '^[[:space:]]*(export[[:space:]]+)?(COMPOSE_|DOCKER_)' .env 2>/dev/null; then
  uscita="il file .env contiene variabili COMPOSE_ o DOCKER_ non permesse"
  codice=1
else
  uscita=$(docker compose -f docker-compose.yml up -d --remove-orphans 2>&1)
  codice=$?
fi
echo "$uscita"
# l'esito si scrive in un file temporaneo di root fuori da richieste/ e poi si sposta al suo posto
# (mv sostituisce un eventuale collegamento simbolico invece di seguirlo)
nuovo=$(mktemp)
python3 - "$codice" "$uscita" > "$nuovo" <<'PY'
import json, sys
from datetime import datetime, timezone
ok = sys.argv[1] == '0'
righe = [r for r in sys.argv[2].splitlines() if r.strip()]
messaggio = 'Impostazioni applicate' if ok else ('Errore: ' + ' / '.join(righe[-3:]))[:500]
print(json.dumps({'quando': datetime.now(timezone.utc).isoformat(), 'ok': ok, 'messaggio': messaggio}))
PY
chmod 644 "$nuovo"
chown 1000:1000 "$nuovo" 2>/dev/null || true
mv -fT "$nuovo" richieste/esito.json
exit "$codice"
