# syntax=docker/dockerfile:1.7
FROM rust:1-bookworm AS rust-build
WORKDIR /app
COPY Cargo.toml ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim AS api
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=rust-build /app/target/release/online-judge /usr/local/bin/online-judge
USER 65532:65532
EXPOSE 3000
ENTRYPOINT ["online-judge", "api"]

FROM python:3.11-slim-bookworm AS worker
# Build and INSTALL Isolate, including /usr/local/etc/isolate. A binary-only copy is insufficient.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git make gcc g++ pkg-config libcap-dev libseccomp-dev libsystemd-dev \
    uidmap && \
    git clone --depth 1 https://github.com/ioi/isolate.git /tmp/isolate && \
    make -C /tmp/isolate install && \
    test -f /usr/local/etc/isolate && \
    (id isolate >/dev/null 2>&1 || useradd -r -M -s /usr/sbin/nologin isolate)
# Assign an unused subordinate ID range; isolate uses it for sandbox identity mapping.
RUN set -eux; \
    sed -i '/^isolate:/d' /etc/subuid /etc/subgid; \
    echo 'isolate:100000:65536' >> /etc/subuid; \
    echo 'isolate:100000:65536' >> /etc/subgid; \
    mkdir -p /var/local/lib/isolate /run/isolate/locks; \
    isolate --check-config
# CPU builds only. Keep torch and numpy preinstalled (no pip at request time).
RUN python -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu && \
    /opt/venv/bin/pip install --no-cache-dir numpy
COPY --from=rust-build /app/target/release/online-judge /usr/local/bin/online-judge
ENV PYTHON_BIN=/opt/venv/bin/python USE_CGROUPS=true \
    PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1
EXPOSE 3001
ENTRYPOINT ["online-judge", "worker"]
