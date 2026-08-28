# ---- build -----------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

# ---- runtime ---------------------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
# The container applies its own schema at boot, so the .sql files ship with it.
COPY migrations ./migrations
COPY package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Migrate, then serve. `dist/db/migrate.js` refuses to run without DATABASE_URL,
# so the guard keeps the in-memory local run (`docker run` with no database)
# booting instead of exiting 1 before the server ever starts.
CMD ["sh", "-c", "if [ -n \"$DATABASE_URL\" ]; then node dist/db/migrate.js; fi && node dist/main.js"]
