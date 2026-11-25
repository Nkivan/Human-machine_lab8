# Stage 1: build client & typecheck workspace
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json tsconfig.tools.json ./
COPY shared/package.json shared/tsconfig.json shared/tsconfig.test.json ./shared/
COPY client/package.json client/tsconfig.json client/tsconfig.node.json client/tsconfig.test.json client/vite.config.ts ./client/
COPY server/package.json server/tsconfig.json ./server/

RUN npm ci

COPY shared/ ./shared/
COPY client/ ./client/
COPY server/ ./server/
COPY tools/ ./tools/

ARG APP_VERSION=v1.0.0
ENV APP_VERSION=$APP_VERSION

RUN npm run typecheck && npm run build

# Stage 2: production runtime image (< 200 MB, non-root, exec CMD)
FROM node:22-alpine AS runner
WORKDIR /app

ARG APP_VERSION=v1.0.0
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV STATIC_DIR=/app/client/dist
ENV LOG_DIR=/app/logs
ENV APP_VERSION=$APP_VERSION

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY client/package.json ./client/
COPY server/package.json ./server/

RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/shared/src ./shared/src
COPY --from=builder /app/shared/package.json ./shared/package.json
COPY --from=builder /app/server/src ./server/src
COPY --from=builder /app/server/tools ./server/tools
COPY --from=builder /app/server/package.json ./server/package.json

RUN addgroup -S dogfight && adduser -S dogfight -G dogfight && mkdir -p /app/logs && chown -R dogfight:dogfight /app
USER dogfight

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--experimental-strip-types", "server/src/index.ts"]
