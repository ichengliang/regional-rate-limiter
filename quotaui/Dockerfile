# quotaui (admin console). One container: the Node BFF serves its HTTP API AND the
# compiled React SPA (SPA_DIR), so quotaui is a single microservice behind one LB.
# Build context is the REPOSITORY ROOT (the BFF loads shared protos from ../proto):
#   docker build -f quotaui/Dockerfile -t quotaui .
FROM node:20-bookworm-slim AS build
WORKDIR /src
COPY proto/ proto/
COPY quotaui/ quotaui/
# Build the SPA (Vite -> quotaui/frontend/dist).
WORKDIR /src/quotaui/frontend
RUN npm ci && npm run build
# Build the BFF (tsc -> quotaui/bff/dist).
WORKDIR /src/quotaui/bff
RUN npm ci && npm run build

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/bff
# Production deps only.
COPY --from=build /src/quotaui/bff/package.json /src/quotaui/bff/package-lock.json ./
RUN npm ci --omit=dev
# Compiled BFF, built SPA, and the proto tree the BFF loads at runtime.
COPY --from=build /src/quotaui/bff/dist/ ./dist/
COPY --from=build /src/quotaui/frontend/dist/ /app/spa/
COPY --from=build /src/proto/ /app/proto/
ENV PORT=8080 \
    SPA_DIR=/app/spa \
    PROTO_ROOT=/app/proto \
    AUTH_MODE=dev
EXPOSE 8080
ENTRYPOINT ["node", "dist/index.js"]
