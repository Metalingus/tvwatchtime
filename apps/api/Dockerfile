FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++ && npm i -g pnpm
COPY pnpm-lock.yaml* package.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @tvwatch/shared build
RUN pnpm --filter @tvwatch/api prisma generate
RUN pnpm --filter @tvwatch/api build

FROM node:20-alpine AS runtime
WORKDIR /app
RUN npm i -g pnpm
COPY --from=build /app ./
RUN apk add --no-cache wget
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget --spider -q http://localhost:4000/health || exit 1
CMD ["node", "apps/api/dist/main.js"]