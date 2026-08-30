FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Explicit copies: `environment/` is the Docker build context, so nothing here
# depends on Harbor's implicit file-upload ordering. The scoring rubric in
# tests/grade.mjs lives OUTSIDE this directory and never reaches the image, so
# the agent cannot read the checks it is graded against.
COPY index.html script.js factory.yaml .gitignore ./
COPY .factory/. .factory/
COPY .pi/. .pi/
COPY tests/. tests/
COPY legacy/. legacy/

RUN git config --global user.email "benchmark@example.test" \
    && git config --global user.name "Factory Benchmark" \
    && git init -b main \
    && git add -A \
    && git commit -m "Initial fixture" \
    && node tests/verify-page.mjs
