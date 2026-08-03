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
      size: "giga",
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

/**
 * 自動予約したコマに「承認」「取消」ボタンを付けた Flex メッセージを作る。
 *
 * 承認しないまま `cancelOn` を迎えると自動で取り消されるため、その日付を本文に
 * 必ず出す。押さないと消える、という前提が伝わらないと事故になる。
 *
 * postback の label は 20 文字までなので、コマ名は本文テキストに出す。
 */
export function buildReservedMessage(
  heading: string,
  slots: string[],
  cancelOn: string,
): FlexMessage {
  const shown = slots.slice(0, MAX_BUTTONS);
  const rows = shown.flatMap((slot) => [
    { type: "text", text: slot, size: "sm", wrap: true },
    {
      type: "box",
      layout: "horizontal",
      spacing: "sm",
      contents: [
        {
          type: "button",
          style: "primary",
          height: "sm",
          action: { type: "postback", label: "承認", data: `approve:${slot}` },
        },
        {
          type: "button",
          style: "secondary",
          height: "sm",
          action: { type: "postback", label: "取消", data: `cancel:${slot}` },
        },
      ],
    },
  ]);

  return {
    type: "flex",
    altText: heading,
    contents: {
      type: "bubble",
      size: "giga",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: heading, weight: "bold", wrap: true },
          { type: "box", layout: "vertical", spacing: "md", contents: rows },
          {
            type: "text",
            text: `${cancelOn} までに承認しないと自動で取り消します。`,
            size: "xs",
            color: "#888888",
            wrap: true,
          },
        ],
      },
    },
  };
}

/**
 * LINE から送る操作の用語。ボタンを押すとこの文字列が送信され、本文に残る。
 * postback と違って何を操作したかが会話に見えるようにするため。
 */
export const TERMS = {
  menu: "メニュー",
  status: "状況",
  auto: "自動",
  approve: "手動",
} as const;

/**
 * 操作メニュー。テキストを受け取ったときに応答で返す。
 *
 * モードは 2 つしかないので、**今のモードを文字で出し、もう片方に変えるボタンを
 * 1 つだけ置く**。選択中を装飾で示そうとすると分かりにくい。
 *
 * 応答（reply）は LINE の無料枠を消費しないため、何度出しても通数は増えない。
 */
export function buildMenuMessage(currentMode: string): FlexMessage {
  const isAuto = currentMode === "auto";
  return {
    type: "flex",
    altText: "メニュー",
    contents: {
      type: "bubble",
      size: "giga",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "text",
            text: isAuto ? "いまは自動で予約します" : "いまは押したら予約します",
            weight: "bold",
            wrap: true,
          },
          {
            type: "button",
            style: "primary",
            height: "sm",
            action: { type: "message", label: "予約状況", text: TERMS.status },
          },
          {
            type: "button",
            style: "secondary",
            height: "sm",
            action: {
              type: "message",
              label: isAuto ? "押したら予約に変える" : "自動で予約に変える",
              text: isAuto ? TERMS.approve : TERMS.auto,
            },
          },
        ],
      },
    },
  };
}

export interface StatusRow {
  /** 取消ボタンに載せるコマ名（slotKey 形式） */
  slot: string;
  /** サイトが取消を受け付けるか。期限切れならボタンを出さない */
  cancellable: boolean;
}

/**
 * 予約状況。本文はそのまま載せ、取消できる予約にだけ取消ボタンを付ける。
 *
 * 期限切れの予約にボタンを出すと、押しても取り消せず紛らわしい。
 */
export function buildStatusMessage(text: string, rows: StatusRow[]): FlexMessage {
  const buttons = rows
    .filter((row) => row.cancellable)
    .slice(0, MAX_BUTTONS)
    .flatMap((row) => [
      { type: "text", text: row.slot, size: "xs", wrap: true },
      {
        type: "button",
        style: "secondary",
        height: "sm",
        action: { type: "postback", label: "取消", data: `cancel:${row.slot}` },
      },
    ]);

  return {
    type: "flex",
    altText: "予約状況",
    contents: {
      type: "bubble",
      size: "giga",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "予約状況", weight: "bold" },
          { type: "text", text, size: "sm", wrap: true },
          ...(buttons.length > 0
            ? [
                { type: "separator" },
                { type: "box", layout: "vertical", spacing: "sm", contents: buttons },
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

/**
 * 任意のメッセージ（Flex 等）を応答で返す。
 * **応答は無料枠（月 200 通）を消費しない**ため、メニューや状況表示はこちらで返す。
 */
export async function replyMessages(
  channelAccessToken: string,
  replyToken: string,
  messages: unknown[],
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  return send(channelAccessToken, REPLY_ENDPOINT, { replyToken, messages }, fetchFn);
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
