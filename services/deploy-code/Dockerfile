FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache \
  bash \
  ca-certificates \
  curl \
  docker-cli \
  docker-cli-compose \
  git \
  openssh-client \
  rsync \
  tar \
  unzip

COPY package*.json ./
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund --loglevel=error --no-update-notifier

COPY src ./src
COPY public ./public

ENV DOCKER_DEPLOY_CODE_PORT=53999
EXPOSE 53999

CMD ["node", "src/index.js"]
