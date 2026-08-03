/**
 * 1 件だけ予約を取り消す（Cloud Run Job）。
 *
 * LINE の「取消」ボタン、または期限が近づいた未承認予約の自動取消から起動される。
 * 取り消すコマは CANCEL_SLOT で渡す。
 *
 * **取消も不可逆。** 取り消したコマはすぐ他の人に取られるうえ、取消期限
 * （使用日の 1 週間前・同一曜日）を過ぎると取り直せない。取消確認画面の照合を
 * 通ったものだけ確定する（`src/cancel.ts`）。
 *
 * ローカル実行:
 *   CANCEL_DRY_RUN=1 CANCEL_SLOT="2026-08-24 第4面 9:00～11:00" bun run cancel
 */
import { cancelReservation } from "../src/cancel";
import { ToshimaClient } from "../src/client";
import { loadCredentials } from "../src/credentials";
import { pushMessage } from "../src/line";
import { CANCELLED_SUBJECT, formatCancellationBody } from "../src/notify";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`環境変数 ${name} が設定されていません`);
  return value;
}

const wanted = required("CANCEL_SLOT");
const lineToken = required("LINE_CHANNEL_ACCESS_TOKEN");
const lineTo = required("LINE_TO");
/** 通知本文に出す取消理由。自動取消と手動取消を区別する。 */
const reason = process.env.CANCEL_REASON?.trim() || "LINE からの操作";

const dryRun = process.env.CANCEL_DRY_RUN === "1";
const credentials = loadCredentials();

/** 結果を LINE に返して終了する。 */
async function finish(text: string): Promise<never> {
  console.log(text);
  await pushMessage(lineToken, lineTo, text);
  process.exit(0);
}

const result = await cancelReservation(
  new ToshimaClient(),
  wanted,
  credentials,
  { dryRun },
);

if (result.outcome === "not-found") {
  await finish(
    `⚠️ ${wanted}\n\n予約一覧に見つかりませんでした。すでに取消済みの可能性があります。`,
  );
}

if (result.outcome === "deadline-passed") {
  // サイトが取消のチェックボックスを出さない＝ウェブから取消できない
  await finish(
    `⚠️ ${wanted}\n\n取消期限（使用日の1週間前・同一曜日）を過ぎているため、` +
      `ウェブから取消できません。窓口または電話での手続きが必要で、キャンセル料が発生します。`,
  );
}

if (result.outcome === "dry-run") {
  await finish(`[dry-run] ${wanted}\n\n取消せずに中断しました。`);
}

await finish(
  `${CANCELLED_SUBJECT}\n\n${formatCancellationBody(wanted, reason, new Date())}`,
);
