# syntax=docker/dockerfile:1
FROM node:24-slim

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
USER node
CMD ["node", "src/index.js"]
