# The pinned Compact compiler is published for Linux x64.
# On other hosts: docker build --platform=linux/amd64 .
FROM node:22.14.0-slim AS toolchain

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates unzip && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate

COPY scripts/install-compact.mjs scripts/install-compact.mjs
RUN node scripts/install-compact.mjs /opt/compact
ENV COMPACTC=/opt/compact/compactc
FROM toolchain AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm compile:midnight:zk
RUN pnpm build

FROM node:22.14.0-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate
COPY --from=build /app/package.json /app/pnpm-lock.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/contracts ./contracts
CMD ["pnpm", "run", "start"]
