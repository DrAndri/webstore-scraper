# Debian 12, Playwright no longer supports Chromium on Debian 11 (bullseye)
FROM node:24-bookworm AS base

WORKDIR /usr/src/app

# Compiles the TypeScript sources, which needs the dev dependencies.
# NODE_ENV is not production here, yarn would skip them.
FROM base AS build
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
RUN yarn build

# Production dependencies only
FROM base AS deps
COPY package.json yarn.lock ./
RUN yarn install --production --frozen-lockfile && yarn cache clean

# The slim image leaves out the build tools, playwright installs the libraries
# Chromium needs
FROM node:24-bookworm-slim AS runner
WORKDIR /usr/src/app
ENV NODE_ENV=production

COPY --from=deps /usr/src/app/node_modules ./node_modules
# Chromium and its system libraries for the crawler type, the version comes from
# the installed playwright package. PlaywrightCrawler launches Chromium unless
# told otherwise. Crawlee measures the memory of the browsers with ps, which the
# slim image leaves out.
RUN npx playwright install --with-deps chromium \
  && apt-get install -y --no-install-recommends procps \
  && rm -rf /var/lib/apt/lists/*

# package.json makes dist an ES module package
COPY package.json ./
COPY --from=build /usr/src/app/dist ./dist
# Store configs used when they are not loaded from GitHub, and the schemas the
# Solr cores are synced with
COPY stores ./stores
COPY solr-configsets ./solr-configsets

EXPOSE 8080
CMD [ "node", "dist/index.js" ]
