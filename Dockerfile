# syntax=docker/dockerfile:1
# Runs TypeScript directly via Node's built-in type stripping (Node >= 22.18).
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY apps ./apps
COPY packages ./packages
COPY migrations ./migrations
COPY scripts ./scripts
COPY README.md ./README.md

RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "apps/api/server.ts"]
