FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Bake nvm + node + the Pi SDK into the image so the agent's install() is a
# fast skip (agent_setup measured ~81s per trial when it reinstalled). Matches
# Harbor's own nvm_node_install_snippet + Pi.install so the agent's
# "command -v pi" check finds it and skips.
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | env -u NODE_VERSION bash \
    && export NVM_DIR="$HOME/.nvm" \
    && . "$NVM_DIR/nvm.sh" \
    && nvm install 22 \
    && nvm alias default 22 \
    && npm install -g --ignore-scripts @earendil-works/pi-coding-agent@latest \
    && pi --version

WORKDIR /app

# Explicit copies: `environment/` is the Docker build context, so nothing here
# depends on Harbor's implicit file-upload ordering. The scoring rubric in
# tests/grade.mjs lives OUTSIDE this directory and never reaches the image, so
# the agent cannot read the checks it is graded against.
COPY index.html script.js factory.yaml .gitignore ./
COPY .factory/. .factory/
COPY .pi/. .pi/
COPY tests/. tests/

RUN git config --global user.email "benchmark@example.test" \
    && git config --global user.name "Factory Benchmark" \
    && git init -b main \
    && git add -A \
    && git commit -m "Initial fixture" \
    && node tests/verify-page.mjs