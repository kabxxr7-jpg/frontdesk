# The front desk server. No runtime dependencies: Node runs the TypeScript files directly (type stripping)
# and stores data with the built-in node:sqlite.
FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DB_FILE=/var/lib/frontdesk/frontdesk.db
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY businesses ./businesses
RUN mkdir -p /var/lib/frontdesk && chown node:node /var/lib/frontdesk
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "scripts/serve.ts"]
