/**
 * LINE Messaging API へのプッシュ通知。
 *
 * LINE Notify は 2025-03-31 に終了したため、公式アカウント（Messaging API）の
 * push message を使う。コミュニケーションプラン（月額無料）は月 200 通までで、
 * 超過分は課金ではなく送信不可になるため、429 は分かる形で失敗させる。
 *
 * Actions のログは public リポジトリでは誰でも読めるので、例外に
 * アクセストークンを載せない。
 */
export const PUSH_ENDPOINT = "https://api.line.me/v2/bot/message/push";
export const REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply";

/** Flex のボタン数上限。多すぎると 1 メッセージに収まらないため頭打ちにする。 */
export const MAX_BUTTONS = 10;

export interface FlexMessage {
  type: "flex";
  altText: string;
  contents: unknown;
}

/**
 * 候補コマを並べ、それぞれに予約ボタンを付けた Flex メッセージを作る。
 * ボタンを押すと postback で `reserve:<コマ>` が webhook に届く。
 *
 * postback の label は 20 文字までなので、コマ名は本文テキストに出し、
 * ボタンは「予約」の一語にして横並びにする。
 */
export function buildCandidateMessage(
  heading: string,
  candidates: string[],
  options: { note?: string } = {},
): FlexMessage {
  const shown = candidates.slice(0, MAX_BUTTONS);
  const rows = shown.map((slot) => ({
    type: "box",
    layout: "horizontal",
    alignItems: "center",
    spacing: "sm",
    contents: [
      { type: "text", text: slot, size: "sm", wrap: true, flex: 3 },
      {
        type: "button",
        style: "primary",
        height: "sm",
        flex: 1,
        action: { type: "postback", label: "予約", data: `reserve:${slot}` },
      },
    ],
  }));

  return {
    type: "flex",
    altText: heading,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: heading, weight: "bold", wrap: true },
          { type: "box", layout: "vertical", spacing: "md", contents: rows },
          ...(candidates.length > shown.length
            ? [
                {
                  type: "text",
                  text: `ほか ${candidates.length - shown.length} 件`,
                  size: "sm",
                  color: "#888888",
                },
              ]
            : []),
          ...(options.note
            ? [
                {
                  type: "text",
                  text: options.note,
                  size: "xs",
                  color: "#888888",
                  wrap: true,
                },
              ]
            : []),
        ],
      },
    },
  };
}

export async function pushMessage(
  channelAccessToken: string,
  to: string,
  text: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  return send(channelAccessToken, PUSH_ENDPOINT, { to, messages: [{ type: "text", text }] }, fetchFn);
}

/** 任意のメッセージ（Flex 等）を push する。 */
export async function pushMessages(
  channelAccessToken: string,
  to: string,
  messages: unknown[],
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  return send(channelAccessToken, PUSH_ENDPOINT, { to, messages }, fetchFn);
}

/**
 * 応答メッセージを返す。webhook で受け取った replyToken に対して送るもので、
 * **無料枠（月 200 通）を消費しない**ため、操作の確認はこちらで返す。
 */
export async function replyMessage(
  channelAccessToken: string,
  replyToken: string,
  text: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  return send(
    channelAccessToken,
    REPLY_ENDPOINT,
    { replyToken, messages: [{ type: "text", text }] },
    fetchFn,
  );
}

async function send(
  channelAccessToken: string,
  endpoint: string,
  payload: unknown,
  fetchFn: typeof fetch,
): Promise<void> {
  const response = await fetchFn(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${channelAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (response.ok) return;

  // 応答本文にトークンが混ざる可能性を排除してから例外に載せる
  const detail = (await response.text()).replaceAll(channelAccessToken, "<token>");

  if (response.status === 429) {
    throw new Error(
      `LINE への送信が拒否されました（429）。月 200 通の無料枠の上限に達した可能性があります: ${detail}`,
    );
  }
  throw new Error(`LINE への送信に失敗しました（${response.status}）: ${detail}`);
}
