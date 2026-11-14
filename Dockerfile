# syntax=docker/dockerfile:1
FROM node:25-slim

ENV NODE_ENV=production
WORKDIR /app

# Production dependencies only. Copied first so this layer is cached
# until package.json or package-lock.json changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# Config comes from environment variables; nothing is read from or written to disk.
# Default process is the bot. Run the PM by overriding the command:
#   node src/pm/cli.js --mode alerts --send --watch
# Injected at build time (see .github/workflows/ci.yml).
ARG APP_VERSION=dev
ARG APP_COMMIT=unknown
ENV APP_VERSION=$APP_VERSION APP_COMMIT=$APP_COMMIT

# Numeric UID:GID so Kubernetes runAsNonRoot can verify it.
USER 65532:65532
# UID 65532 has no home directory; give tools a HOME that exists.
ENV HOME=/tmp
CMD ["node", "src/index.js"]
