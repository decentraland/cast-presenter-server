FROM node:24-trixie-slim@sha256:287c662bed62f3c7b68ea68544814eaff9d7ed2254d2fc9627f2df5957bb7401 as builderenv

WORKDIR /app

# install dependencies
COPY package.json /app/package.json
COPY yarn.lock /app/yarn.lock
RUN yarn install --frozen-lockfile

# build the app
COPY . /app
RUN yarn build

# remove devDependencies, keep only used dependencies
RUN yarn install --prod --frozen-lockfile

########################## END OF BUILD STAGE ##########################

FROM node:24-trixie-slim@sha256:287c662bed62f3c7b68ea68544814eaff9d7ed2254d2fc9627f2df5957bb7401

RUN apt-get update && apt-get install -y --no-install-recommends \
  tini ffmpeg ca-certificates \
  fontconfig fonts-liberation fonts-noto-core fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

# NODE_ENV is used to configure some runtime options, like JSON logger
ENV NODE_ENV production

ARG COMMIT_HASH=local
ENV COMMIT_HASH=${COMMIT_HASH:-local}

ARG CURRENT_VERSION=Unknown
ENV CURRENT_VERSION=${CURRENT_VERSION:-Unknown}

RUN groupadd -g 1001 appuser && useradd -u 1001 -g appuser -s /bin/sh appuser

WORKDIR /app
RUN chown appuser:appuser /app
COPY --chown=appuser:appuser --from=builderenv /app/dist /app/dist
COPY --chown=appuser:appuser --from=builderenv /app/node_modules /app/node_modules
COPY --chown=appuser:appuser --from=builderenv /app/package.json /app/package.json
COPY --chown=appuser:appuser --from=builderenv /app/.env.default /app/.env.default

USER appuser
RUN echo "" > /app/.env

# Please _DO NOT_ use a custom ENTRYPOINT because it may prevent signals
# (i.e. SIGTERM) to reach the service
# Read more here: https://aws.amazon.com/blogs/containers/graceful-shutdowns-with-ecs/
#            and: https://www.ctl.io/developers/blog/post/gracefully-stopping-docker-containers/
ENTRYPOINT ["/usr/bin/tini", "--"]
# Run the program under Tini
CMD [ "/usr/local/bin/node", "--trace-warnings", "--abort-on-uncaught-exception", "--unhandled-rejections=strict", "dist/index.js" ]
