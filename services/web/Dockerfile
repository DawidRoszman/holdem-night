# syntax=docker/dockerfile:1
# Stage 1: compile Tailwind CSS and bundle the three.js table (src/ -> public/)
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src ./src
COPY public ./public
RUN npm run build

# Stage 2: static files + gateway
FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/public /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1
