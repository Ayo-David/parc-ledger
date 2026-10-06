FROM node:22.21.1-alpine AS build
RUN corepack enable && corepack prepare yarn@1.22.19 --activate
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
RUN yarn build
FROM node:22.21.1-alpine
RUN corepack enable && corepack prepare yarn@1.22.19 --activate
WORKDIR /app
ENV NODE_ENV=production
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/src/server.js"]
