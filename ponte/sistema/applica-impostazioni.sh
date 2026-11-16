#!/usr/bin/env bash
# Applica le impostazioni salvate dal pannello: "docker compose up -d" riavvia solo le parti
# del server con valori cambiati. Lo lancia il servizio radio-ponte-impostazioni quando il pannello
# lascia la richiesta richieste/applica. Scrive l'esito in richieste/esito.json per il pannello.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
rm -f richieste/applica
uscita=$(docker compose up -d --remove-orphans 2>&1)
codice=$?
echo "$uscita"
python3 - "$codice" "$uscita" > richieste/esito.json.nuovo <<'PY'
import json, sys
from datetime import datetime, timezone
ok = sys.argv[1] == '0'
righe = [r for r in sys.argv[2].splitlines() if r.strip()]
messaggio = 'Impostazioni applicate' if ok else ('Errore: ' + ' / '.join(righe[-3:]))[:500]
print(json.dumps({'quando': datetime.now(timezone.utc).isoformat(), 'ok': ok, 'messaggio': messaggio}))
PY
chmod 644 richieste/esito.json.nuovo
mv richieste/esito.json.nuovo richieste/esito.json
exit "$codice"
