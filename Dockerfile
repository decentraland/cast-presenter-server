FROM node:24-alpine as builderenv

WORKDIR /app

# build deps for native modules (@napi-rs/canvas ships prebuilt, but @livekit/rtc-node may need build tools)
RUN apk add --no-cache build-base python3

# install dependencies
COPY package.json /app/package.json
COPY yarn.lock /app/yarn.lock
RUN yarn

# build the app
COPY . /app
RUN yarn build
RUN yarn test

# remove devDependencies, keep only used dependencies
RUN yarn install --frozen-lockfile --production

########################## END OF BUILD STAGE ##########################

FROM node:24-alpine

# NODE_ENV is used to configure some runtime options, like JSON logger
ENV NODE_ENV production

# Runtime deps: tini and ffmpeg
RUN apk add --no-cache tini ffmpeg

RUN addgroup -g 1001 -S appuser && adduser -S appuser -u 1001

WORKDIR /app
COPY --from=builderenv /app /app
RUN chown -R appuser:appuser /app

USER appuser

# Please _DO NOT_ use a custom ENTRYPOINT because it may prevent signals
# (i.e. SIGTERM) to reach the service
# Read more here: https://aws.amazon.com/blogs/containers/graceful-shutdowns-with-ecs/
#            and: https://www.ctl.io/developers/blog/post/gracefully-stopping-docker-containers/
ENTRYPOINT ["/sbin/tini", "--"]
# Run the program under Tini
CMD [ "/usr/local/bin/node", "--trace-warnings", "--abort-on-uncaught-exception", "--unhandled-rejections=strict", "dist/index.js" ]
