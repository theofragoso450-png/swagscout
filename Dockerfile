# SwagScout — production image
# Requires Node 23+ for the built-in node:sqlite driver (no native build step).
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
# playwright-core is an optional runtime dep for the Mercari fallback; no
# browsers are bundled — mount/chromium users can set PLAYWRIGHT_EXECUTABLE_PATH.
VOLUME ["/app/data"]
EXPOSE 3080
CMD ["node", "dist/index.js"]
