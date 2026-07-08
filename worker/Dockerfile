# glibc base (Debian), NOT alpine/musl: @temporalio/core-bridge is a native Rust addon whose
# only Linux x64 prebuild is x86_64-unknown-linux-gnu, which needs glibc's ld-linux-x86-64.so.2.
# Alpine (musl) lacks that linker, so the worker crashes on boot with ERR_DLOPEN_FAILED the moment
# Temporal is enabled. Keep both stages on the same glibc base so the prebuilt .node copied from
# deps matches the runtime.
FROM node:22-slim AS deps
WORKDIR /app
# npm ci against the committed lockfile — a bare `npm install` from package.json
# re-resolves every semver range at image-build time, so the deployed dependency
# set silently drifts from what was tested (bit us with the Temporal SDK/webpack
# isolation advisory: the image picked up webpack 5.108.x days after the lockfile
# was verified safe).
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS runner
WORKDIR /app
# node:*-slim ships no system trust store, so Temporal's Rust core (rustls-native-certs) fails to
# verify Temporal Cloud's server cert with `NativeCertsNotFound`. Install the root CAs. (Our
# TEMPORAL_TLS_CERT/KEY are the *client* identity for mTLS; this is the separate server-trust side.)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production

CMD ["node", "--import", "tsx/esm", "src/worker.ts"]
