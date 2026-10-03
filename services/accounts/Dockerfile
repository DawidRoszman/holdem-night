# syntax=docker/dockerfile:1
FROM node:24-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM deps AS test
COPY . .
RUN npm test

FROM node:24-alpine AS runtime
ENV NODE_ENV=production PORT=4002 DB_PATH=/data/accounts.db
WORKDIR /app
COPY --from=deps /app ./
COPY src ./src
# the SQLite database lives on a volume mounted here; the image sets its owner
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 4002
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4002/health || exit 1
CMD ["node", "src/server.js"]
