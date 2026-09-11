FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

RUN mkdir -p /var/lib/yuvomi-banking \
  && chown -R node:node /app /var/lib/yuvomi-banking

COPY entrypoint.sh /usr/local/bin/yuvomi-banking-entrypoint
RUN chmod 755 /usr/local/bin/yuvomi-banking-entrypoint

EXPOSE 3100

ENTRYPOINT ["/usr/local/bin/yuvomi-banking-entrypoint"]
CMD ["node", "dist/src/server.js"]
