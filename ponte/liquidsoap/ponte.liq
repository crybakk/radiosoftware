# Ponte di Radio Regia
# Riceve il programma dalla regia via SRT, lo tratta (processore audio),
# lo manda ad AzuraCast come sorgente live (come faceva RadioDJ) e
# segnala al servizio di controllo collegamenti, cadute e silenzi.
#
# Tutte le impostazioni arrivano dalle variabili d'ambiente (file .env).

settings.log.stdout.set(true)
settings.log.file.set(false)
settings.log.level.set(3)
settings.init.allow_root.set(true)

def env(name, default) =
  environment.get(name, default=default)
end

srt_port = int_of_string(default=9000, env("SRT_PORT", "9000"))
srt_passphrase = env("SRT_PASSPHRASE", "")
srt_buffer = float_of_string(default=10., env("SRT_BUFFER_SECONDS", "10"))
processing = env("PROCESSORE_AUDIO", "medio")
silence_seconds = float_of_string(default=20., env("ALLARME_SILENZIO_SECONDI", "20"))
controllo = env("CONTROLLO_INTERNO", "http://controllo:8091")

az_host = env("AZURACAST_HOST", "")
az_port = int_of_string(default=8005, env("AZURACAST_PORTA_DJ", "8005"))
az_mount = env("AZURACAST_MOUNT_DJ", "/")
az_user = env("AZURACAST_DJ_UTENTE", "")
az_password = env("AZURACAST_DJ_PASSWORD", "")
station_name = env("NOME_RADIO", "Radio")

esterna_port = int_of_string(default=9010, env("ESTERNA_PORTA", "9010"))
esterna_mount = env("ESTERNA_MOUNT", "/")
esterna_user = env("ESTERNA_UTENTE", "esterna")
esterna_password = env("ESTERNA_PASSWORD", "")

microfono_attivo = env("MICROFONO_REMOTO", "si") != "no"
ducking_db = float_of_string(default=-12., env("ABBASSAMENTO_MUSICA_DB", "-12"))
ritorno_url = env("RITORNO_VOCE", "rtp://controllo:41040?pkt_size=1200")

# --- notifiche al servizio di controllo (non bloccanti) ---
def notify(kind, detail) =
  thread.run(
    fun () ->
      begin
        try
          ignore(
            http.post(
              timeout=5.,
              headers=[("Content-Type", "application/json")],
              data=json.stringify({kind=kind, detail=detail}),
              "#{controllo}/internal/event"
            )
          )
        catch err do
          log.important("Notifica non inviata: #{err}")
        end
      end
  )
end

# --- ingresso dalla regia ---
studio =
  if
    srt_passphrase == ""
  then
    input.srt(
      id="studio",
      port=srt_port,
      max=srt_buffer,
      on_connect=fun () -> notify("studio_connesso", ""),
      on_disconnect=fun () -> notify("studio_scollegato", "")
    )
  else
    input.srt(
      id="studio",
      port=srt_port,
      max=srt_buffer,
      passphrase=srt_passphrase,
      enforced_encryption=true,
      on_connect=fun () -> notify("studio_connesso", ""),
      on_disconnect=fun () -> notify("studio_scollegato", "")
    )
  end

# --- titolo e artista in onda, inviati dalla regia tramite il controllo ---
titoli = insert_metadata(studio)
programma = titoli

# --- diretta esterna (stessa app usata finora come DJ su AzuraCast) ---
# Quando un'app si collega qui ha la precedenza sulla regia; quando si scollega
# si torna da soli alla regia.
esterna_attiva = esterna_password != ""
esterna =
  if
    esterna_attiva
  then
    input.harbor(
      id="esterna",
      port=esterna_port,
      user=esterna_user,
      password=esterna_password,
      buffer=2.,
      max=10.,
      on_connect=fun (_) -> notify("esterna_collegata", ""),
      on_disconnect=fun () -> notify("esterna_scollegata", ""),
      esterna_mount
    )
  else
    log.important("ESTERNA_PASSWORD vuota: ingresso per le dirette esterne disattivato")
    source.fail()
  end

# --- diretta autonoma: musica dalla libreria del server, scelta dal pannello ---
# Il controllo decide i brani e li mette in questa coda.
autonoma_attiva = ref(false)
autonoma_coda = request.queue(id="autonoma_coda")
autonoma_suona = amplify(1., override="liq_amplify", autonoma_coda)
# Niente sfumature tra i brani: in questo percorso crossfade salta il primo brano dopo una
# pausa e fade.in/fade.out danno silenzio con Liquidsoap 2.3.3 (provato). I brani si susseguono.
autonoma_suona.on_track(
  fun (m) -> if m["filename"] != "" then notify("autonoma_brano", m["filename"]) end
)
# Disponibile solo quando ha brani in coda: a diretta ferma la coda è vuota.
autonoma = autonoma_suona

def dissolvenza(a, b) =
  add(normalize=false, [fade.in(duration=1., b), fade.out(duration=1., a)])
end
def diretto(_, b) =
  add(normalize=false, [b])
end
programma =
  fallback(
    id="selettore",
    track_sensitive=false,
    # la diretta autonoma parte subito, senza dissolvenza dalla sorgente precedente
    transitions=[dissolvenza, diretto, dissolvenza],
    [esterna, autonoma, programma]
  )

# --- microfono remoto (voce del conduttore dal pannello, via il controllo) ---
# La voce arriva in RTP (Opus) dal servizio di controllo. Quando è "in onda" la
# musica si abbassa di ABBASSAMENTO_MUSICA_DB e la voce sale, con transizioni morbide.
voce_in_onda = ref(false)
g_voce = ref(0.)
g_musica = ref(1.)
abbassata = lin_of_dB(ducking_db)
thread.run(
  every=0.02,
  fun () ->
    begin
      obiettivo_voce = if voce_in_onda() then 1. else 0. end
      obiettivo_musica = if voce_in_onda() then abbassata else 1. end
      g_voce := g_voce() + (obiettivo_voce - g_voce()) * 0.15
      g_musica := g_musica() + (obiettivo_musica - g_musica()) * 0.15
    end
)

def con_voce(programma) =
  voce =
    input.ffmpeg(
      id="voce",
      self_sync=true,
      max_buffer=0.5,
      string_args=[("protocol_whitelist", "file,udp,rtp")],
      format="sdp",
      "/cfg/voce.sdp"
    )
  # orologio separato: se la voce non arriva il programma non si ferma
  voce = buffer(id="buffer_voce", buffer=0.06, max=0.5, voce)
  musica = amplify({g_musica()}, programma)

  # ritorno in cuffia al conduttore: il programma (già abbassato) senza la sua voce
  output.url(
    id="ritorno_voce",
    fallible=true,
    url=ritorno_url,
    %ffmpeg(
      format = "rtp",
      %audio(codec = "libopus", samplerate = 48000, channels = 2, b = "96k")
    ),
    mksafe(musica)
  )

  # la voce si aggiunge solo quando c'è un programma (regia o esterna): senza,
  # l'uscita verso AzuraCast resta ferma e AzuraCast passa alla sua AutoDJ
  switch(
    id="mixer_voce",
    track_sensitive=false,
    [({source.is_ready(programma)}, add(normalize=false, [musica, amplify({g_voce()}, voce)]))]
  )
end

programma =
  if
    microfono_attivo
  then
    con_voce(programma)
  else
    log.important("MICROFONO_REMOTO=no: microfono dal pannello disattivato")
    programma
  end

# --- processore audio ---
def processa(s) =
  if
    processing == "leggero"
  then
    limit(threshold=-1., compress(threshold=-14., ratio=2., attack=20., release=400., gain=1., s))
  elsif
    processing == "medio"
  then
    limit(threshold=-1., compress(threshold=-18., ratio=3., attack=10., release=250., gain=3., s))
  elsif
    processing == "forte"
  then
    limit(threshold=-1., compress(threshold=-22., ratio=5., attack=5., release=150., gain=6., s))
  else
    s
  end
end
uscita = processa(programma)

# --- allarme silenzio ---
uscita =
  blank.detect(
    max_blank=silence_seconds,
    threshold=-50.,
    on_noise=fun () -> notify("audio_ripreso", ""),
    fun () -> notify("silenzio", string(silence_seconds)),
    uscita
  )

# --- HTTP interno: metadati e stato (solo rete Docker, porta non pubblicata) ---
def set_metadata(req) =
  try
    let json.parse (m : {artist: string, title: string}) = req.body()
    titoli.insert_metadata([("artist", m.artist), ("title", m.title)])
    http.response(content_type="application/json", data="{\"ok\":true}")
  catch _ do
    http.response(status_code=400, content_type="application/json", data="{\"ok\":false}")
  end
end
harbor.http.register.simple(port=8092, method="POST", "/metadata", set_metadata)

def set_voce(req) =
  try
    let json.parse (m : {on: bool}) = req.body()
    voce_in_onda := m.on
    stato_voce = if m.on then "IN ONDA" else "fuori onda" end
    log.important("Microfono remoto: #{stato_voce}")
    http.response(content_type="application/json", data="{\"ok\":true}")
  catch _ do
    http.response(status_code=400, content_type="application/json", data="{\"ok\":false}")
  end
end
harbor.http.register.simple(port=8092, method="POST", "/voce", set_voce)

def risposta_ok() =
  http.response(content_type="application/json", data="{\"ok\":true}")
end
def risposta_errore() =
  http.response(status_code=400, content_type="application/json", data="{\"ok\":false}")
end

def set_autonoma(req) =
  try
    let json.parse (m : {on: bool}) = req.body()
    autonoma_attiva := m.on
    if not m.on then
      # fuori onda: si svuota la coda, così alla ripartenza non suona un brano vecchio
      list.iter(fun (r) -> request.destroy(r), autonoma_coda.queue())
      autonoma_coda.set_queue([])
      autonoma_coda.skip()
    end
    risposta_ok()
  catch _ do
    risposta_errore()
  end
end
harbor.http.register.simple(port=8092, method="POST", "/autonoma", set_autonoma)

def autonoma_aggiungi(req) =
  try
    let json.parse (m : {uri: string}) = req.body()
    autonoma_coda.push.uri(m.uri)
    risposta_ok()
  catch _ do
    risposta_errore()
  end
end
harbor.http.register.simple(port=8092, method="POST", "/autonoma/aggiungi", autonoma_aggiungi)

def autonoma_salta(_) =
  autonoma_coda.skip()
  risposta_ok()
end
harbor.http.register.simple(port=8092, method="POST", "/autonoma/salta", autonoma_salta)

def stato(_) =
  http.response(
    content_type="application/json",
    data=json.stringify({studio=studio.is_ready(), esterna=esterna.is_ready(), voce=voce_in_onda(), autonoma=autonoma_attiva()})
  )
end
harbor.http.register.simple(port=8092, method="GET", "/stato", stato)

# --- uscita verso AzuraCast ---
# fallible=true: se la regia si scollega l'uscita si ferma, AzuraCast
# se ne accorge e passa alla sua AutoDJ di riserva.
if
  az_host == ""
then
  log.important("AZURACAST_HOST non impostato: nessuna uscita verso AzuraCast")
  output.dummy(fallible=true, uscita)
else
  output.icecast(
    %mp3(bitrate = 320, samplerate = 44100),
    id="azuracast",
    host=az_host,
    port=az_port,
    mount=az_mount,
    user=az_user,
    password=az_password,
    name=station_name,
    fallible=true,
    on_connect=fun () -> notify("azuracast_collegato", ""),
    on_disconnect=fun () -> notify("azuracast_scollegato", ""),
    on_error=fun (err) -> begin notify("azuracast_errore", err) 5. end,
    uscita
  )
end
