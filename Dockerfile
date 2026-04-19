# a2e-shell — imagen base de producción.
# Consumidor: agente LLM sobre HTTP. NO humano.
# Construye en CI/prod Linux. En dev Windows no se usa esta imagen.

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev


FROM node:22-bookworm-slim AS runtime

# --- CLIs base que conforman la capability surface por defecto. ---
# Extender esta sección es la forma SOPORTADA de ampliar el agente.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      jq \
      git \
      grep \
      sed \
      gawk \
      ripgrep \
      coreutils \
      xz-utils \
      unzip \
    && rm -rf /var/lib/apt/lists/*

# gh (GitHub CLI)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# aws-cli v2
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscli.zip \
 && unzip -q /tmp/awscli.zip -d /tmp \
 && /tmp/aws/install \
 && rm -rf /tmp/awscli.zip /tmp/aws

# kubectl
RUN curl -fsSL "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/$(dpkg --print-architecture)/kubectl" -o /usr/local/bin/kubectl \
 && chmod +x /usr/local/bin/kubectl

# --- Usuario no-root. ---
RUN useradd --create-home --shell /usr/sbin/nologin --uid 10001 a2e \
 && mkdir -p /app /sessions \
 && chown -R a2e:a2e /app /sessions

WORKDIR /app
COPY --from=builder --chown=a2e:a2e /app/node_modules ./node_modules
COPY --from=builder --chown=a2e:a2e /app/dist ./dist
COPY --chown=a2e:a2e package.json ./

USER a2e

ENV NODE_ENV=production \
    A2E_SESSIONS_DIR=/sessions \
    A2E_PORT=8080

EXPOSE 8080

# Health check por el endpoint GET /sessions/:id/state con id dummy sería 404; usamos /healthz.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${A2E_PORT}/healthz || exit 1

CMD ["node", "dist/index.js"]
