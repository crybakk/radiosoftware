# Ponte di Radio Regia
# Riceve il programma dalla regia via SRT, lo tratta (processore audio),
# lo manda all'Icecast principale (sullo stesso server), all'Icecast secondario esterno, al flusso HLS
# e alle dirette video, e segnala al servizio di controllo collegamenti, cadute e silenzi.
# Senza nessuna diretta suona da solo la libreria del server (riserva).
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

# Icecast principale: il contenitore "icecast" accanto al ponte
ice_main_host = env("ICECAST_HOST", "icecast")
ice_main_port = int_of_string(default=8000, env("ICECAST_PORTA_INTERNA", "8000"))
ice_main_mount = env("ICECAST_MOUNT", "/radio.mp3")
ice_main_password = env("ICECAST_PASSWORD_SORGENTE", "")
ice_bitrate = int_of_string(default=128, env("ICECAST_BITRATE", "128"))
station_name = env("NOME_RADIO", "Radio")

esterna_port = int_of_string(default=9010, env("ESTERNA_PORTA", "9010"))
esterna_mount = env("ESTERNA_MOUNT", "/")
esterna_user = env("ESTERNA_UTENTE", "esterna")
esterna_password = env("ESTERNA_PASSWORD", "")

microfono_attivo = env("MICROFONO_REMOTO", "si") != "no"
ducking_db = float_of_string(default=-12., env("ABBASSAMENTO_MUSICA_DB", "-12"))
ritorno_host = env("RITORNO_VOCE_HOST", "controllo")

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

# --- diretta esterna (l'app usata finora come DJ su AzuraCast: BUTT, Larix, Luci Live…) ---
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

# --- voci dal pannello: microfono del conduttore e fino a 3 ospiti (via il controllo) ---
# Ogni voce arriva in RTP (Opus) dal servizio di controllo, su una porta sua (41030, 41032, ...:
# porte pari, perché RTP usa anche la porta successiva per RTCP). Quando almeno
# una è "in onda" la musica si abbassa di ABBASSAMENTO_MUSICA_DB, con transizioni morbide.
# Ognuno riceve in cuffia il programma e le altre voci in onda, ma non la propria (mix-minus).
def voce_slot(nome, porta_ritorno) =
  {nome=nome, porta_ritorno=porta_ritorno, in_onda=ref(false), g=ref(0.)}
end
voci = [
  voce_slot("voce", 41040),
  voce_slot("ospite1", 41042),
  voce_slot("ospite2", 41044),
  voce_slot("ospite3", 41046)
]
g_musica = ref(1.)
abbassata = lin_of_dB(ducking_db)
thread.run(
  every=0.02,
  fun () ->
    begin
      qualcuna = list.exists(fun (v) -> v.in_onda(), voci)
      list.iter(
        fun (v) ->
          begin
            obiettivo = if v.in_onda() then 1. else 0. end
            v.g := v.g() + (obiettivo - v.g()) * 0.15
          end,
        voci
      )
      obiettivo_musica = if qualcuna then abbassata else 1. end
      g_musica := g_musica() + (obiettivo_musica - g_musica()) * 0.15
    end
)

def con_voce(programma) =
  musica = amplify({g_musica()}, programma)
  ingressi =
    list.map(
      fun (v) ->
        begin
          s =
            input.ffmpeg(
              id=v.nome,
              self_sync=true,
              max_buffer=0.5,
              string_args=[("protocol_whitelist", "file,udp,rtp")],
              format="sdp",
              "/cfg/#{v.nome}.sdp"
            )
          # orologio separato: se la voce non arriva il programma non si ferma
          s = buffer(id="buffer_#{v.nome}", buffer=0.06, max=0.5, s)
          (v.nome, amplify({v.g()}, s))
        end,
      voci
    )

  # ritorno in cuffia: il programma (già abbassato) e le altre voci, senza la propria
  list.iter(
    fun (v) ->
      begin
        altre = list.map(snd, list.filter(fun (x) -> fst(x) != v.nome, ingressi))
        ignore(
          output.url(
            id="ritorno_#{v.nome}",
            fallible=true,
            url="rtp://#{ritorno_host}:#{v.porta_ritorno}?pkt_size=1200",
            %ffmpeg(
              format = "rtp",
              %audio(codec = "libopus", samplerate = 48000, channels = 2, b = "96k")
            ),
            mksafe(add(normalize=false, list.cons(musica, altre)))
          )
        )
      end,
    voci
  )

  # le voci si aggiungono solo quando c'è un programma (regia, esterna o autonoma): senza,
  # va in onda la riserva del ponte
  switch(
    id="mixer_voce",
    track_sensitive=false,
    [({source.is_ready(programma)}, add(normalize=false, list.cons(musica, list.map(snd, ingressi))))]
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

uscita = programma

# --- allarme silenzio ---
uscita =
  blank.detect(
    max_blank=silence_seconds,
    threshold=-50.,
    on_noise=fun () -> notify("audio_ripreso", ""),
    fun () -> notify("silenzio", string(silence_seconds)),
    uscita
  )

# --- riserva del ponte (flusso di emergenza): musica a caso dalla libreria del server ---
# Va in onda quando non c'è né regia né diretta autonoma né esterna. Tutte le uscite del ponte
# (Icecast principale, Icecast secondario, dirette video) hanno lo stesso segnale: se cade il server
# di streaming principale gli ascoltatori passano al secondario e sentono la stessa cosa.
# Il controllo sceglie il brano (niente artisti ripetuti) e lo passa già con il volume corretto,
# il titolo e l'artista (metadati per Icecast e per i lettori degli ascoltatori).
# Scelte di cristian (17/11/2026):
# - la riserva parte solo dopo RISERVA_ATTESA_SECONDI senza programma (di base 8): un salto breve
#   del collegamento non la fa partire (nel frattempo silenzio);
# - ogni volta che parte, la riserva comincia da un brano nuovo, dall'inizio (mai a metà).
riserva_attesa = float_of_string(default=8., env("RISERVA_ATTESA_SECONDI", "8"))
def prossimo_riserva() =
  try
    r = http.get(timeout=5., "#{controllo}/internal/riserva")
    uri = string.trim(string(r))
    if r.status_code == 200 and uri != "" then request.create(uri) else null() end
  catch _ do
    null()
  end
end
riserva_brani = request.dynamic(id="riserva", retry_delay=10., prossimo_riserva)
riserva = amplify(1., override="liq_amplify", riserva_brani)
# per il registro dei brani suonati dal server (report SIAE)
riserva.on_track(fun (m) -> if m["filename"] != "" then notify("riserva_brano", m["filename"]) end)

# ultimo istante in cui c'era un programma da mandare in onda
ultimo_programma = ref(time())
def programma_pronto() =
  if source.is_ready(uscita) then
    ultimo_programma := time()
    true
  else
    false
  end
end
riserva_in_onda = ref(false)
def verso_riserva(a, b) =
  riserva_in_onda := true
  dissolvenza(a, b)
end
def verso_programma(a, b) =
  riserva_in_onda := false
  # finita la dissolvenza si scarta il brano lasciato a metà: la prossima volta la riserva
  # riparte da un brano nuovo
  thread.run(
    delay=2.,
    fun () -> if not riserva_in_onda() then riserva_brani.skip() end
  )
  dissolvenza(a, b)
end
segnale =
  switch(
    id="segnale",
    track_sensitive=false,
    transitions=[verso_programma, verso_riserva],
    [
      (programma_pronto, uscita),
      ({time() - ultimo_programma() >= riserva_attesa}, riserva)
    ]
  )
# se anche la libreria è vuota va silenzio, così le uscite restano collegate
segnale_sicuro = mksafe(segnale)

# --- processore audio ---
# Uno solo, dopo la scelta tra programma e riserva: tutte le uscite hanno lo stesso suono.
def processa_interno(livello, s) =
  if
    livello == "leggero"
  then
    limit(threshold=-1., compress(threshold=-14., ratio=2., attack=20., release=400., gain=1., s))
  elsif
    livello == "medio"
  then
    limit(threshold=-1., compress(threshold=-18., ratio=3., attack=10., release=250., gain=3., s))
  elsif
    livello == "forte"
  then
    limit(threshold=-1., compress(threshold=-22., ratio=5., attack=5., release=150., gain=6., s))
  else
    s
  end
end

# Stereo Tool (Thimeo): libreria per Linux scaricata da riavvia.sh in ./stereotool, preset (.sts)
# caricato dal pannello. La chiave di licenza è facoltativa: senza, Stereo Tool aggiunge bip o una voce
# solo se il preset usa funzioni a pagamento. Scelta di cristian (17/11/2026): se Stereo Tool non parte
# (libreria o preset mancanti o rovinati) si usa il processore "medio" e arriva un allarme.
stereotool_cartella = env("STEREOTOOL_CARTELLA", "/stereotool")
stereotool_libreria = "#{stereotool_cartella}/libStereoTool.so"
stereotool_preset = "#{stereotool_cartella}/preset.sts"
stereotool_chiave = env("STEREOTOOL_CHIAVE", "")
# "spento", "attivo" oppure il motivo per cui non è partito (letto dal controllo con /stato)
stereotool_stato = ref("spento")
def processa(s) =
  if
    processing != "stereotool"
  then
    processa_interno(processing, s)
  elsif
    not file.exists(stereotool_libreria)
  then
    stereotool_stato := "manca la libreria di Stereo Tool sul server"
    processa_interno("medio", s)
  elsif
    not file.exists(stereotool_preset)
  then
    stereotool_stato := "manca il preset: caricalo dal pannello"
    processa_interno("medio", s)
  else
    try
      st =
        stereotool(
          library_file=stereotool_libreria,
          license_key=(stereotool_chiave == "" ? null() : stereotool_chiave),
          preset=stereotool_preset,
          s
        )
      if not st.valid_license() then
        log.important("Stereo Tool senza licenza: funzioni a pagamento usate: #{st.unlincensed_used_features()}")
      end
      stereotool_stato := "attivo"
      log.important("Stereo Tool attivo")
      (st:source(audio=pcm(stereo)))
    catch err do
      stereotool_stato := "non parte: #{err.message}"
      processa_interno("medio", s)
    end
  end
end
segnale_sicuro = processa(segnale_sicuro)
stereotool_ok = stereotool_stato() == "spento" or stereotool_stato() == "attivo"
if not stereotool_ok then
  log.important("Stereo Tool: #{stereotool_stato()}. Uso il processore medio")
end
# all'avvio si dice al controllo come è andata (apre o chiude l'allarme); il controllo potrebbe non essere
# ancora pronto, per questo si aspetta un po'
thread.run(
  delay=20.,
  fun () ->
    if stereotool_ok then notify("stereotool_#{stereotool_stato()}", "") else notify("stereotool_errore", stereotool_stato()) end
)

# --- Icecast secondario esterno (MP3), stesso segnale del principale ---
ice_host = env("ICECAST_ESTERNO_HOST", "")
if
  ice_host != ""
then
  output.icecast(
    %mp3(bitrate = ice_bitrate, samplerate = 44100),
    id="icecast_esterno",
    host=ice_host,
    port=int_of_string(default=8000, env("ICECAST_ESTERNO_PORTA", "8000")),
    mount=env("ICECAST_ESTERNO_MOUNT", "/radio.mp3"),
    user=env("ICECAST_ESTERNO_UTENTE", "source"),
    password=env("ICECAST_ESTERNO_PASSWORD", ""),
    name=station_name,
    on_connect=fun () -> notify("icecast_esterno_collegato", ""),
    on_disconnect=fun () -> notify("icecast_esterno_scollegato", ""),
    on_error=fun (err) -> begin notify("icecast_esterno_errore", err) 10. end,
    segnale_sicuro
  )
end

# --- programma per il servizio di controllo (dirette video), solo rete Docker ---
output.harbor(
  %mp3(bitrate = 320, samplerate = 44100),
  id="interno",
  port=8093,
  mount="programma",
  segnale_sicuro
)

# --- flusso HLS (scelte di cristian, 17/11/2026) ---
# Tre qualità AAC (64, 128 e 192 kbit/s): il lettore sceglie da solo in base alla rete. Pezzi da
# 6 secondi. I file stanno in memoria (volume tmpfs "hls"): Caddy manda i pezzi, il controllo le playlist
# (così conta gli ascoltatori). Indirizzo come AzuraCast: https://DOMINIO/hls/<stazione>/live.m3u8
hls_cartella = env("HLS_CARTELLA", "/hls")
if
  env("HLS", "si") == "no"
then
  log.important("HLS=no: flusso HLS spento")
else
  hls_aac_64 = %ffmpeg(format = "mpegts", %audio(codec = "aac", samplerate = 44100, channels = 2, b = "64k"))
  hls_aac_128 = %ffmpeg(format = "mpegts", %audio(codec = "aac", samplerate = 44100, channels = 2, b = "128k"))
  hls_aac_192 = %ffmpeg(format = "mpegts", %audio(codec = "aac", samplerate = 44100, channels = 2, b = "192k"))
  output.file.hls(
    id="hls",
    playlist="live.m3u8",
    segment_duration=6.,
    segments=5,
    segments_overhead=5,
    perm=420,
    hls_cartella,
    [
      ("aac_lofi", hls_aac_64.{bandwidth=72000, codecs="mp4a.40.2"}),
      ("aac_midfi", hls_aac_128.{bandwidth=140000, codecs="mp4a.40.2"}),
      ("aac_hifi", hls_aac_192.{bandwidth=208000, codecs="mp4a.40.2"})
    ],
    segnale_sicuro
  )
end

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
    let json.parse (m : {on: bool, slot: string?}) = req.body()
    nome = m.slot ?? "voce"
    trovate = list.filter(fun (v) -> v.nome == nome, voci)
    if list.is_empty(trovate) then
      http.response(status_code=404, content_type="application/json", data="{\"ok\":false}")
    else
      list.iter(fun (v) -> v.in_onda := m.on, trovate)
      stato_voce = if m.on then "IN ONDA" else "fuori onda" end
      log.important("Voce #{nome}: #{stato_voce}")
      http.response(content_type="application/json", data="{\"ok\":true}")
    end
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
    data=json.stringify({studio=studio.is_ready(), esterna=esterna.is_ready(), voce=list.map(fun (v) -> (v.nome, v.in_onda()), voci), autonoma=autonoma_attiva(), stereotool=stereotool_stato()})
  )
end
harbor.http.register.simple(port=8092, method="GET", "/stato", stato)

# --- Icecast principale (sullo stesso server, contenitore "icecast") ---
if
  ice_main_password == ""
then
  log.important("ICECAST_PASSWORD_SORGENTE vuota: nessuna uscita verso l'Icecast principale")
else
  output.icecast(
    %mp3(bitrate = ice_bitrate, samplerate = 44100),
    id="icecast_principale",
    host=ice_main_host,
    port=ice_main_port,
    mount=ice_main_mount,
    user="source",
    password=ice_main_password,
    name=station_name,
    on_connect=fun () -> notify("icecast_principale_collegato", ""),
    on_disconnect=fun () -> notify("icecast_principale_scollegato", ""),
    on_error=fun (err) -> begin notify("icecast_principale_errore", err) 5. end,
    segnale_sicuro
  )
end
