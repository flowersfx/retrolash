# Build: client (Vite) + server (esbuild bundle). The runtime image has no node_modules.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run typecheck && npm run build

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    STATIC_DIR=/app/dist
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "--enable-source-maps", "dist-server/main.js"]
