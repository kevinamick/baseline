# glibc base (Debian), NOT alpine/musl: @temporalio/core-bridge is a native Rust addon whose
# only Linux x64 prebuild is x86_64-unknown-linux-gnu, which needs glibc's ld-linux-x86-64.so.2.
# Alpine (musl) lacks that linker, so the worker crashes on boot with ERR_DLOPEN_FAILED the moment
# Temporal is enabled. Keep both stages on the same glibc base so the prebuilt .node copied from
# deps matches the runtime.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json ./
RUN npm install

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
