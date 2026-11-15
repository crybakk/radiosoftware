# Debian (non Alpine): la voce sintetica (sherpa-onnx) è compilata per glibc
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production TZ=Europe/Rome
# ffmpeg: dirette video, puntate, annunci; bzip2: per estrarre le voci scaricate
RUN apt-get update && apt-get install -y --no-install-recommends tzdata ffmpeg bzip2 ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY pannello ./pannello
# cartella dati scrivibile dall'utente del servizio (il volume Docker ne eredita i permessi)
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 9080
CMD ["node", "src/server.ts"]
