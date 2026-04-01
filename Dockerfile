# ── Stage 1: Base with pnpm ──────────────────────────────────────────
FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

# ── Stage 2: Install dependencies ───────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

# ── Stage 3: Build everything ────────────────────────────────────────
FROM deps AS build
COPY turbo.json tsconfig*.json ./
COPY apps/ apps/
RUN pnpm build

# ── Stage 4: Server runtime ─────────────────────────────────────────
FROM base AS server
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
ENV NODE_ENV=production
ENV BROWSER=echo
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY apps/server/package.json apps/server/
# Create non-root user so Claude Code allows bypassPermissions mode
RUN useradd -m conductor && \
    chown -R conductor:conductor /home/conductor /app
# Entrypoint fixes volume ownership then drops to conductor user
COPY apps/server/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 3001
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "apps/server/dist/index.js"]

# ── Stage 5: Web runtime (nginx) ────────────────────────────────────
FROM nginx:alpine AS web
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
