# The headless Datanotes engine on a vault folder, without Obsidian.
# Build context: the repository root, after `npm run build:service`:
#   docker build -f deploy/docker/Dockerfile -t datanotes-service .
FROM node:22-alpine

RUN addgroup -S engine && adduser -S -G engine engine \
    && mkdir -p /vault /config /logs /data && chown engine:engine /config /logs /data
# The engine's store (journal, transaction log, tokens, change feed, logs): /data/<database id>/,
# outside the vault. Mount a volume there to keep it.
ENV DATANOTES_DATA_HOME=/data
COPY dist/datanotes-service.cjs /app/datanotes-service.cjs
COPY deploy/docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

USER engine
WORKDIR /app
EXPOSE 27150
# GET / answers without a token
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD wget -q -O /dev/null http://127.0.0.1:${DATANOTES_PORT:-27150}/ || exit 1
ENTRYPOINT ["/app/entrypoint.sh"]
