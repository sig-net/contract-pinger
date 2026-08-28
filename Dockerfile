FROM node:22.14.0-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.4.1 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# Built here rather than shipped from the repo, so the image cannot run an
# artifact that has drifted from its source.
RUN pnpm build

CMD [ "pnpm", "run", "start" ]