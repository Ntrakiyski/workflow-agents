FROM node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json vite.config.ts index.html ./
COPY src ./src
COPY web ./web
RUN npm run build && npm prune --omit=dev
FROM node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752
WORKDIR /app
ENV NODE_ENV=production PORT=8082
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public ./public
COPY --chown=node:node scripts/application-backup.mjs ./scripts/application-backup.mjs
COPY package.json ./
USER node
EXPOSE 8082
CMD ["node","dist/main.js"]
