FROM node:22-alpine

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

# A link pasted through "Change link" is saved here; mount a volume to keep it.
ENV PORT=3210 \
    CONFIG_FILE=/data/config.json
RUN mkdir /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO /dev/null http://127.0.0.1:3210/icon.svg || exit 1
CMD ["node", "server.js"]
