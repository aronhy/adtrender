ARG NODE_VERSION=24.14.1
FROM node:${NODE_VERSION}-bookworm-slim
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers \
    HOME=/home/node
WORKDIR /opt/ad-research/app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates openssh-client && rm -rf /var/lib/apt/lists/*
COPY runtime/package.json runtime/package-lock.json ./
COPY runtime/schema.prisma ./schema.prisma
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && DATABASE_URL=postgresql://unused:unused@127.0.0.1:1/unused ./node_modules/.bin/prisma generate --schema schema.prisma \
    && ./node_modules/.bin/playwright install --with-deps chromium \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*
USER node:node
