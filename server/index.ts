/**
 * LINE Webhook を受けて予約を起動する HTTP サーバー（Cloud Run 用）。
 *
 * LINE のボタンが押されると postback が届き、次の 2 段の検証を通ったものだけを
 * Cloud Run Job（reserve）に流す。
 *   1. X-Line-Signature をチャネルシークレットで検証
 *   2. 送信者の userId が LINE_TO と一致するか照合
 *
 * 公式アカウントは誰でも友だち追加できるため、2 が無いと第三者が利用者の
 * アカウントで有料のコートを予約できてしまう。
 *
 * 実際の予約は Cloud Run Job（reserve）が行う。予約システムの認証情報を
 * webhook 側に置かずに済ませるための分担。webhook は Job を起動するだけで、
 * 利用者番号もパスワードも知らない。
 */
import { replyMessage } from "../src/line";
import { runReserveJob } from "../src/runjob";
import { extractReserveCommands, verifySignature } from "../src/webhook";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`環境変数 ${name} が設定されていません`);
  return value;
}

const channelSecret = required("LINE_CHANNEL_SECRET");
const channelAccessToken = required("LINE_CHANNEL_ACCESS_TOKEN");
const allowedUserId = required("LINE_TO");
const jobTarget = {
  project: required("GCP_PROJECT"),
  region: required("GCP_REGION"),
  job: required("RESERVE_JOB"),
};
const port = Number(process.env.PORT ?? 8080);

Bun.serve({
  port,
  routes: {
    // /healthz は Cloud Run 側が横取りして自前のサーバーに届かない
    "/health": () => new Response("ok"),

    "/webhook": {
      POST: async (req) => {
        // 署名検証は生のボディに対して行うため、先に文字列で読む
        const rawBody = await req.text();
        const signature = req.headers.get("x-line-signature");

        if (!(await verifySignature(channelSecret, rawBody, signature))) {
          console.warn("署名検証に失敗したリクエストを拒否しました");
          return new Response("invalid signature", { status: 401 });
        }

        let body: unknown;
        try {
          body = JSON.parse(rawBody);
        } catch {
          return new Response("invalid json", { status: 400 });
        }

        const commands = extractReserveCommands(body, allowedUserId);

        // LINE は素早い 200 応答を期待する。処理は投げっぱなしにする。
        for (const { slot, replyToken } of commands) {
          void (async () => {
            try {
              await runReserveJob(jobTarget, slot);
              console.log(`予約を起動しました: ${slot}`);
              if (replyToken) {
                await replyMessage(
                  channelAccessToken,
                  replyToken,
                  `予約処理を開始しました。\n${slot}\n\n結果は改めて通知します。`,
                );
              }
            } catch (e) {
              console.error("予約の起動に失敗:", (e as Error).message);
              if (replyToken) {
                await replyMessage(
                  channelAccessToken,
                  replyToken,
                  `予約の起動に失敗しました。\n${(e as Error).message}`,
                ).catch(() => {});
              }
            }
          })();
        }

        return new Response("ok");
      },
    },
  },

  fetch: () => new Response("not found", { status: 404 }),
});

console.log(`webhook server listening on :${port}`);
