# Rust job container — replaces api/container (node + c2pa-node).
# Multi-stage: build the static-ish binary, run it on a slim Debian base.
FROM rust:1-bookworm AS build
WORKDIR /src
# c2pa's default features use openssl for some signing paths.
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
COPY api/container-rs/Cargo.toml api/container-rs/Cargo.lock ./
COPY api/container-rs/src ./src
RUN cargo build --release --locked && strip target/release/c2pa-verify-container

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/c2pa-verify-container /usr/local/bin/c2pa-verify-container
EXPOSE 8080
# The server listens on 8080 and writes temporary files under /tmp only —
# no root needed at runtime.
USER nobody
CMD ["c2pa-verify-container"]
