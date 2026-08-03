/**
 * LINE Webhook の検証とイベント解釈。
 *
 * Webhook は公開エンドポイントなので、次の 2 段で守る。
 *   1. X-Line-Signature をチャネルシークレットで検証し、LINE 以外からの
 *      リクエストを弾く
 *   2. 送信者の userId が自分と一致するか照合する。公式アカウントは誰でも
 *      友だち追加できるため、署名検証だけでは第三者が予約を叩ける
 *
 * 2 が抜けると、ボットを見つけた他人が利用者の口座で有料のコートを
 * 予約できてしまう。必ず両方を通すこと。
 */

const encoder = new TextEncoder();

async function hmacKey(channelSecret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** 署名を作る（テストと自己検証用）。 */
export async function sign(channelSecret: string, body: string): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(channelSecret),
    encoder.encode(body),
  );
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

/**
 * X-Line-Signature を検証する。
 * 比較は crypto.subtle.verify に任せる（自前の文字列比較を書かない）。
 */
export async function verifySignature(
  channelSecret: string,
  rawBody: string,
  signature: string | null | undefined,
): Promise<boolean> {
  if (!signature) return false;

  let signatureBytes: Uint8Array<ArrayBuffer>;
  try {
    const binary = atob(signature);
    signatureBytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) signatureBytes[i] = binary.charCodeAt(i);
  } catch {
    return false; // base64 として壊れている
  }

  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(channelSecret),
    signatureBytes,
    encoder.encode(rawBody),
  );
}

/**
 * 操作の種類。
 *   reserve … 候補を予約する
 *   approve … 自動予約した予約を承認する（自動取消の対象から外す）
 *   cancel  … 予約を取り消す
 *   status  … 予約一覧と取消期限を表示する
 *   mode    … 動作モードを切り替える（slot に approve / auto が入る）
 *   menu    … 操作メニューを表示する（テキストを受け取ったとき）
 *   settings… 希望条件を表示する
 *   day     … 希望する曜日を入れ替える（slot に 0〜6）
 *   time    … 希望する時間帯を入れ替える（slot に "9:00～11:00" 等）
 *   max     … 月の上限を変える（slot に件数）
 */
export type CommandAction =
  | "reserve"
  | "approve"
  | "cancel"
  | "status"
  | "mode"
  | "menu"
  | "settings"
  | "day"
  | "time"
  | "max";

const ACTIONS: CommandAction[] = [
  "reserve",
  "approve",
  "cancel",
  "status",
  "mode",
  "settings",
  "day",
  "time",
  "max",
];

/** 対象のコマ（や値）を必要とする操作。status / menu は対象を持たない。 */
const NEEDS_ARGUMENT: CommandAction[] = [
  "reserve",
  "approve",
  "cancel",
  "mode",
  "day",
  "time",
  "max",
];

/**
 * テキストで受け付ける用語。
 *
 * **予約と取消はここに入れない。** 不可逆な操作をテキストで走らせると、誤送信や
 * 引用・転送で事故る。コマを指定する操作は postback のボタンだけにしてある。
 */
const TEXT_COMMANDS: Record<string, { action: CommandAction; slot: string }> = {
  メニュー: { action: "menu", slot: "" },
  状況: { action: "status", slot: "" },
  条件: { action: "settings", slot: "" },
  自動: { action: "mode", slot: "auto" },
  手動: { action: "mode", slot: "approve" },
};

export interface Command {
  action: CommandAction;
  /** 対象のコマ（slotKey 形式） */
  slot: string;
  /** 応答メッセージ用のトークン（応答は無料枠を消費しない） */
  replyToken: string;
}

export interface ReserveCommand {
  /** 予約するコマ（slotKey 形式） */
  slot: string;
  /** 応答メッセージ用のトークン（応答は無料枠を消費しない） */
  replyToken: string;
}

/**
 * Webhook の本文から、自分が出した操作指示だけを取り出す。
 * 自分以外の userId、postback 以外のイベント、想定外の data はすべて捨てる。
 *
 * **取消も第三者に叩かせてはいけない。** 予約と同じく userId を照合する。
 */
export function extractCommands(
  body: unknown,
  allowedUserId: string,
): Command[] {
  const events = (body as { events?: unknown })?.events;
  if (!Array.isArray(events)) return [];

  const commands: Command[] = [];
  for (const event of events) {
    if (event?.source?.userId !== allowedUserId) continue;
    const replyToken = String(event.replyToken ?? "");

    // テキストは決めた用語だけに反応する。メニューのボタンはこの用語を送信するので、
    // 何を操作したかが会話に残る。関係ない発言では何も返さない。
    if (event?.type === "message") {
      if (event?.message?.type !== "text") continue;
      const command = TEXT_COMMANDS[String(event.message.text).trim()];
      if (command) commands.push({ ...command, replyToken });
      continue;
    }

    if (event?.type !== "postback") continue;

    const data = event?.postback?.data;
    if (typeof data !== "string") continue;

    const separator = data.indexOf(":");
    if (separator < 0) continue;

    const action = data.slice(0, separator) as CommandAction;
    if (!ACTIONS.includes(action)) continue;

    const slot = data.slice(separator + 1).trim();
    if (!slot && NEEDS_ARGUMENT.includes(action)) continue;

    commands.push({ action, slot, replyToken });
  }
  return commands;
}

/** 予約指示だけを取り出す（従来の呼び出し口）。 */
export function extractReserveCommands(
  body: unknown,
  allowedUserId: string,
): ReserveCommand[] {
  return extractCommands(body, allowedUserId)
    .filter((c) => c.action === "reserve")
    .map(({ slot, replyToken }) => ({ slot, replyToken }));
}
