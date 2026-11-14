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
programma = insert_metadata(studio)

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
    programma.insert_metadata([("artist", m.artist), ("title", m.title)])
    http.response(content_type="application/json", data="{\"ok\":true}")
  catch _ do
    http.response(status_code=400, content_type="application/json", data="{\"ok\":false}")
  end
end
harbor.http.register.simple(port=8092, method="POST", "/metadata", set_metadata)

def stato(_) =
  http.response(
    content_type="application/json",
    data=json.stringify({studio=studio.is_ready()})
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
