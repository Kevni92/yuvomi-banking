FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

RUN mkdir -p /var/lib/yuvomi-banking \
  && chown -R node:node /app /var/lib/yuvomi-banking
USER node

EXPOSE 3100

CMD ["node", "dist/src/server.js"]
