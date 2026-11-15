FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=Europe/Rome
RUN apk add --no-cache tzdata
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
USER node
EXPOSE 9080
CMD ["node", "src/server.ts"]
