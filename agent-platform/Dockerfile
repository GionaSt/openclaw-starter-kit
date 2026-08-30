# Dockerfile della Agent Platform.
#
# Follow-up di 0673d624/task fa880252: l'immagine `agent-platform` gira
# sull'host ma non esisteva un Dockerfile nel repo -> compose non riproducibile
# da zero. Questo file la rende buildabile con `docker build .` (o
# `docker compose build` da deploy/, vedi deploy/docker-compose.yml).
#
# Layout atteso a runtime (vedi deploy/docker-compose.yml):
#   - WORKDIR /app, CMD "node server/index.js", porta 3100 (ricavato:
#     server/index.js, PORT default 3100).
#   - server/data, knowledge/, repos/, backups/, server/config sono montati
#     come VOLUMI dal compose: qui vengono copiati solo come fallback/dev,
#     il compose li sovrascrive a runtime.
#   - Il container deve avere SOLO `node` (l'healthcheck del compose fa il
#     probe HTTP con `node -e ...`, niente curl/wget): node:*-alpine va bene
#     così com'è, nessun pacchetto aggiuntivo va installato.
#
# Multi-stage: la web (PWA React/Vite) viene buildata a parte e il bundle
# statico copiato in web/dist, che server/index.js serve se presente
# (express.static, vedi server/index.js: `const DIST = .../web/dist`).
# Se in futuro la UI viene deployata/servita diversamente, lo stage web-build
# e la relativa COPY sotto si possono rimuovere senza impatti sul backend.

# ---- Stage 1: build della PWA (web/) ----
FROM node:24-alpine AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- Stage 2: dipendenze prod del server ----
FROM node:24-alpine AS server-deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev

# ---- Stage 3: immagine runtime finale ----
FROM node:24-alpine
WORKDIR /app

COPY server/ ./server/
COPY --from=server-deps /app/server/node_modules ./server/node_modules
COPY --from=web-build /app/web/dist ./web/dist

EXPOSE 3100

CMD ["node", "server/index.js"]
