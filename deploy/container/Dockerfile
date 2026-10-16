# Build context is a fresh prepare-release directory containing apps/web/, packages/contracts/ and scripts/.
FROM node:24.14.1-bookworm-slim

ENV npm_config_audit=false \
    npm_config_fund=false \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global npm@11.18.0 --ignore-scripts --no-audit --no-fund \
    && test "$(node --version)" = "v24.14.1" \
    && test "$(npm --version)" = "11.18.0"

WORKDIR /opt/ad-research
COPY release-manifest.json ./release-manifest.json
COPY packages/contracts/ ./packages/contracts/
COPY apps/web/ ./apps/web/
COPY scripts/ ./scripts/
COPY deploy/container/check-browser.mjs ./check-browser.mjs
COPY deploy/container/verify-services.mjs ./verify-services.mjs
WORKDIR /opt/ad-research/apps/web

# Explicit generation avoids dependence on package install lifecycle permissions.
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund \
    && node -e "const fs=require('node:fs');if(JSON.parse(fs.readFileSync('.wasp/out/.waspinfo')).buildType !== 'Production') process.exit(1)" \
    && node node_modules/prisma/build/index.js generate --schema=.wasp/out/db/schema.prisma \
    && node ../../scripts/build-api.mjs \
    && node --check dist-worker/index.mjs \
    && node -e "if(require('playwright/package.json').version !== '1.62.1') process.exit(1)" \
    && node node_modules/playwright/cli.js install --with-deps chromium \
    && chmod -R a+rX /opt/playwright-browsers \
    && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache

ENV NODE_ENV=production \
    PORT=3001 \
    META_BROWSER_CHANNEL=chromium
USER node:node
EXPOSE 3001
CMD ["node", "--enable-source-maps", ".wasp/out/server/bundle/server.js"]
