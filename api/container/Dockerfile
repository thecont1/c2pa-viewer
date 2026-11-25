FROM node:22-bookworm-slim
WORKDIR /app
COPY api/container/package.json /app/package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY api/container/server.js /app/server.js
COPY api/container/engine-node.js /app/engine-node.js
COPY packages/core /app/core
EXPOSE 8080
CMD ["node", "server.js"]
