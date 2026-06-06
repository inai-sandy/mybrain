# syntax=docker/dockerfile:1

# 1) Build the React frontend
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json ./
RUN npm install
COPY web/ ./
RUN npm run build

# 2) Build the NestJS backend
FROM node:22-alpine AS api
WORKDIR /api
COPY api/package.json ./
RUN npm install
COPY api/ ./
RUN npm run build

# 3) Runtime image
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY api/package.json ./
RUN npm install --omit=dev
COPY --from=api /api/dist ./dist
COPY --from=web /web/dist ./public
EXPOSE 8080
CMD ["node", "dist/main.js"]
