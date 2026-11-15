FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=Europe/Rome
# ffmpeg: dirette video verso YouTube e Facebook
RUN apk add --no-cache tzdata ffmpeg
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY pannello ./pannello
# cartella dati scrivibile dall'utente del servizio (il volume Docker ne eredita i permessi)
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 9080
CMD ["node", "src/server.ts"]
