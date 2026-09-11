# ---- Build stage ----
# pgvector@0.3.0 requires Node >=22 — node:20 produced an EBADENGINE warning
# on every `npm ci` (harmless on its own, npm keeps going, but worth fixing).
FROM node:22-bullseye AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Runtime stage ----
FROM node:22-bullseye-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

# copy compiled output from the build stage
COPY --from=build /app/dist ./dist

# protoLoader reads this at runtime relative to __dirname (dist/protos), and
# tsc only compiles .ts files, so the raw .proto has to be copied in by hand
COPY --from=build /app/src/protos/service.proto ./dist/protos/service.proto

EXPOSE 3000

CMD ["node", "dist/main.js"]
