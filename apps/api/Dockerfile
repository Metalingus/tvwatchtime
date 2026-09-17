FROM node:20-alpine AS build

WORKDIR /app

RUN apk add --no-cache python3 make g++ openssl libc6-compat && npm i -g pnpm@9.12.0

COPY pnpm-lock.yaml* package.json pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter @tvwatch/shared build
RUN pnpm --filter @tvwatch/api prisma generate
RUN pnpm --filter @tvwatch/api build


FROM node:20-alpine AS runtime

WORKDIR /app

LABEL org.opencontainers.image.source="https://github.com/Metalingus/TVWatchTime"
LABEL org.opencontainers.image.title="TVWatchTime API"
LABEL org.opencontainers.image.description="NestJS backend for TVWatchTime"

RUN apk add --no-cache openssl libc6-compat wget && npm i -g pnpm@9.12.0

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget --spider -q http://localhost:4000/health || exit 1

CMD ["node", "apps/api/dist/main.js"]