FROM node:20-alpine AS build
WORKDIR /app
RUN npm i -g pnpm
COPY pnpm-lock.yaml* package.json pnpm-workspace.yaml ./
COPY apps/admin/package.json apps/admin/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @tvwatch/shared build
RUN pnpm --filter @tvwatch/admin build

FROM node:20-alpine AS runtime
WORKDIR /app
LABEL org.opencontainers.image.source="https://github.com/Metalingus/TVWatchTime"
LABEL org.opencontainers.image.title="TVWatchTime Admin"
LABEL org.opencontainers.image.description="Next.js admin console for TVWatchTime"
ENV NODE_ENV=production
COPY --from=build /app/apps/admin/.next/standalone ./
COPY --from=build /app/apps/admin/.next/static ./apps/admin/.next/static
EXPOSE 3000
CMD ["node", "apps/admin/server.js"]