# Image unique pour l'API et le worker.
#   docker build --target api -t automatisation-mail-api .
#   docker build --target worker -t automatisation-mail-worker .
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
RUN pnpm install --frozen-lockfile --filter "!@am/web"
RUN pnpm --filter @am/core --filter @am/db --filter @am/api --filter @am/worker build
RUN pnpm deploy --filter @am/api --prod /out/api && pnpm deploy --filter @am/worker --prod /out/worker

FROM node:22-alpine AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out/api ./
EXPOSE 4000
CMD ["node", "dist/server.js"]

FROM node:22-alpine AS worker
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out/worker ./
CMD ["node", "dist/index.js"]
