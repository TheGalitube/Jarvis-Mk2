# Runtime image only: no host mounts, Docker socket, or privileged mode is
# required. SSH reaches explicitly configured remote targets from this boundary.
FROM node:20-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client \
    && npm install --global @openai/codex \
    && apt-get purge -y --auto-remove \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=node:node . .
RUN mkdir -p /app/builds /app/data /home/node/.codex /home/node/.ssh \
    && chown -R node:node /app /home/node

USER node
ENV NODE_ENV=production \
    PORT=3210 \
    JARVIS_BIND_HOST=0.0.0.0
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3210/healthz',{headers:{Host:'127.0.0.1:3210'}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
