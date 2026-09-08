ARG BENCHMARK_IMAGE
FROM node:22-bookworm-slim AS node
FROM ${BENCHMARK_IMAGE}
COPY --from=node /usr/local/bin/node /usr/local/bin/node
USER root
WORKDIR /source
