# webhook サーバーと 2 つの Job（poll / reserve）で共用するイメージ。
# 起動するスクリプトは Cloud Run 側の command で切り替える。
FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ ./src/
COPY server/ ./server/
COPY scripts/ ./scripts/
COPY reserve.json ./

ENV PORT=8080
EXPOSE 8080

CMD ["bun", "run", "server/index.ts"]
