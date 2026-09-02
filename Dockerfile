# App image only. Postgres/Redis are external (separate URLs via env).
# Node 24 native type stripping — no build step, no ts-node.
FROM node:24-alpine

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Install production deps only (no build step, so devDeps are unnecessary at runtime)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

# App source
COPY src ./src

# Run as non-root
USER node

EXPOSE 3000

# Env vars (DATABASE_URL, REDIS_URL, ...) come from the container (Dokploy).
CMD ["node", "src/server.ts"]
