# Builds the React app (from the "frontend" build context — the owlbot_frontend
# repo) and serves it with Caddy, which also proxies the API and gets HTTPS
# certificates automatically.

# ---- Build the web app ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=frontend package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY --from=frontend . .
# Baked into the JS bundle at build time. Never pass secrets here — anything
# VITE_* ends up readable in the browser.
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL
# Vite alone (the type check runs in development / CI); keeps memory low on a small server.
RUN npx vite build

# ---- Serve ----
FROM caddy:2.10-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
