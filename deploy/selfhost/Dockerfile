# Self-host image built from a source checkout by the root docker-compose.yaml.
# The build stage produces the same reviewed release directory as
# scripts/prepare-release.mjs; the api stage then mirrors deploy/container/Dockerfile.
ARG NODE_IMAGE=node:24.14.1-bookworm-slim

FROM ${NODE_IMAGE} AS build
ARG API_URL
ARG APP_URL
ARG ADMIN_URL
ENV npm_config_audit=false \
    npm_config_fund=false \
    WASP_TELEMETRY_DISABLE=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global npm@11.18.0 --ignore-scripts --no-audit --no-fund
WORKDIR /src
COPY toolchain/package.json toolchain/package-lock.json toolchain/
RUN cd toolchain && npm ci
COPY packages/contracts/ packages/contracts/
COPY apps/web/package.json apps/web/package-lock.json apps/web/.npmrc apps/web/
RUN cd apps/web && npm ci
COPY . .
RUN test -n "$API_URL" && test -n "$APP_URL" && test -n "$ADMIN_URL" || { echo "Set API_URL, APP_URL and ADMIN_URL to the public HTTPS origins." >&2; exit 1; } \
    && ./scripts/bootstrap-wasp.sh \
    && ./scripts/wasp.sh build \
    && cd apps/web \
    && REACT_APP_API_URL="$API_URL" VITE_APP_SURFACE=customer VITE_CUSTOMER_APP_ORIGIN="$APP_URL" VITE_ADMIN_APP_ORIGIN="$ADMIN_URL" node node_modules/vite/bin/vite.js build \
    && node ../../scripts/build-worker.mjs \
    && node ../../scripts/prepare-release.mjs --output /release --release-id selfhost --public-api-url "$API_URL" \
    && REACT_APP_API_URL="$API_URL" VITE_APP_SURFACE=admin VITE_CUSTOMER_APP_ORIGIN="$APP_URL" VITE_ADMIN_APP_ORIGIN="$ADMIN_URL" node node_modules/vite/bin/vite.js build \
    && mkdir /admin-public \
    && cp -a .wasp/out/web-app/build/. /admin-public/

FROM ${NODE_IMAGE} AS api
ENV npm_config_audit=false \
    npm_config_fund=false \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global npm@11.18.0 --ignore-scripts --no-audit --no-fund
WORKDIR /opt/ad-research
COPY --from=build /release/release-manifest.json ./release-manifest.json
COPY --from=build /release/packages/contracts/ ./packages/contracts/
COPY --from=build /release/apps/web/ ./apps/web/
COPY --from=build /release/scripts/ ./scripts/
WORKDIR /opt/ad-research/apps/web
# Explicit generation avoids dependence on package install lifecycle permissions.
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund \
    && node node_modules/prisma/build/index.js generate --schema=.wasp/out/db/schema.prisma \
    && node ../../scripts/build-api.mjs \
    && node --check dist-worker/index.mjs \
    && node node_modules/playwright/cli.js install --with-deps chromium \
    && chmod -R a+rX /opt/playwright-browsers \
    && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache
ENV NODE_ENV=production \
    PORT=3001 \
    META_BROWSER_CHANNEL=chromium
USER node:node
EXPOSE 3001
CMD ["node", "--enable-source-maps", ".wasp/out/server/bundle/server.js"]

# Static site plus the HTTPS entry point for the web app, API and object storage.
FROM caddy:2.10.2-alpine AS web
COPY --from=build /release/public/ /srv/public/
COPY --from=build /admin-public/ /srv/admin/
COPY deploy/selfhost/Caddyfile /etc/caddy/Caddyfile
COPY --chmod=0755 deploy/selfhost/caddy-entrypoint.sh /usr/local/bin/caddy-entrypoint.sh
RUN mkdir -p /trust
CMD ["/usr/local/bin/caddy-entrypoint.sh"]
