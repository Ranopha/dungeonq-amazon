FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d
ARG RUNTIME_UID=1000
ARG RUNTIME_GID=1000
WORKDIR /app
COPY package.json package-lock.json ./
# Locked test clients are included for reference acceptance. No install scripts run.
RUN npm ci --ignore-scripts --omit=optional --no-audit --no-fund && npm cache clean --force
COPY runtime/ ./runtime/
COPY world/ ./world/
COPY server/world-store.mjs ./server/world-store.mjs
COPY sdk/runtime-client.mjs ./sdk/runtime-client.mjs
COPY public/runtime/ ./public/runtime/
RUN mkdir -p /state /run/dungeonq && chown ${RUNTIME_UID}:${RUNTIME_GID} /state && chmod 700 /state
ENV NODE_ENV=production HOME=/tmp
USER ${RUNTIME_UID}:${RUNTIME_GID}
ARG SOURCE_DIGEST
LABEL org.dungeonq.profile="runtime-reference-v1" org.dungeonq.source-digest="${SOURCE_DIGEST}"
CMD ["node", "--version"]
