# The Baseline web app (Next.js). glibc base to match the worker image; the app itself has no
# native addons but shares `worker/src` (the provider registry and dataset-adapter seam are
# imported across the package boundary at build time), so both source trees are copied in.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* values are inlined at build time. The compose file passes the in-network
# gateway URL and the local anon key; override the build args for any other topology.
ARG NEXT_PUBLIC_SUPABASE_URL=http://gateway:8000
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/messages ./messages
COPY --from=build /app/src ./src
COPY --from=build /app/worker/src ./worker/src
EXPOSE 3000
CMD ["npm", "run", "start"]
