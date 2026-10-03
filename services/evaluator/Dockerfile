# syntax=docker/dockerfile:1
FROM node:24-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM deps AS test
COPY . .
RUN npm test

FROM node:24-alpine AS runtime
ENV NODE_ENV=production PORT=4001
WORKDIR /app
COPY --from=deps /app ./
COPY src ./src
USER node
EXPOSE 4001
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4001/health || exit 1
CMD ["node", "src/server.js"]
