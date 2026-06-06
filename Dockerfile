# syntax=docker/dockerfile:1

# 1) Build the React frontend
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json ./
RUN npm install
COPY web/ ./
RUN npm run build

# 2) Build the NestJS backend (prisma generate + tsc)
FROM node:22-alpine AS api
RUN apk add --no-cache openssl
WORKDIR /api
COPY api/package.json ./
RUN npm install
COPY api/ ./
RUN npm run build

# 3) Runtime image
FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY api/package.json ./
RUN npm install --omit=dev
COPY api/prisma ./prisma
RUN npx prisma generate
COPY --from=api /api/dist ./dist
COPY --from=web /web/dist ./public
EXPOSE 8080
# Apply migrations against the mounted data volume, then start.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
