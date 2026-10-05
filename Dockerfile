# ---- Build stage ----
FROM node:22-bullseye AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
# Compiles to dist/ and copies src/protos/service.proto next to the gRPC client.
RUN npm run build

# ---- Runtime stage ----
FROM node:22-bullseye-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Run as the unprivileged "node" user; auth_state (WhatsApp session) is writable for it.
RUN mkdir -p /app/auth_state && chown -R node:node /app
USER node

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# One process per CPU (CLUSTER_WORKERS to override). Use "node dist/main.js" for a single process.
CMD ["node", "dist/cluster.js"]
