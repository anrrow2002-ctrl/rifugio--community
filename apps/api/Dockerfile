FROM node:24-bookworm-slim
WORKDIR /app
COPY apps/api/package*.json apps/api/
RUN npm --prefix apps/api ci --omit=dev
COPY apps/api apps/api
COPY apps/web apps/web
COPY config config
RUN mkdir -p /app/data /app/private && chown -R node:node /app
USER node
WORKDIR /app/apps/api
EXPOSE 3457
CMD ["node", "server.js"]
