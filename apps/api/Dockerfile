FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY apps/api/package*.json apps/api/
RUN npm --prefix apps/api ci --omit=dev
COPY apps/api apps/api
COPY packages/mcp packages/mcp
COPY config config
RUN mkdir -p /app/data /app/private && chown -R node:node /app
USER node
WORKDIR /app/apps/api
EXPOSE 3457
CMD ["node", "server.js"]
