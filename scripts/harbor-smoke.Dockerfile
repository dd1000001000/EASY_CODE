# Disposable, unprivileged integration-test environment; no model credentials.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc libc6-dev linux-libc-dev python3 python3-django git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /source
