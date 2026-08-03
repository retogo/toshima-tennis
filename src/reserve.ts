/**
 * 1 コマ分の予約実行。
 *
 * 画面遷移は 空き照会 → コマ選択 → ログイン → 詳細申請 → 申込確認 → 申込完了。
 * 申込確認の内容が押さえたいコマと一致していることを確かめてから確定する。
 * 照合に失敗した場合は確定 POST を送らずに中断する。
 *
 * dryRun を指定すると申込確認の照合までを行い、確定 POST は送らない。
 */
import { BASE_URL, type ApplicationDetails, type ToshimaClient } from "./client";
import { verifyConfirmation } from "./confirmation";
import { slotKey } from "./notify";
import { findReservation, parseReservations } from "./reservations";
import type { TimeSlot } from "./parser";

export interface ReserveOptions {
  dryRun?: boolean;
}

/**
 * コマ選択済みの状態から予約を確定させる。
 * client は openTimeSlots まで進んでいること。
 */
export async function reserveSlot(
  client: ToshimaClient,
  slot: TimeSlot,
  credentials: { userId: string; password: string },
  details: ApplicationDetails,
  options: ReserveOptions = {},
): Promise<void> {
  // コマを選んでログイン画面へ
  await client.postBack(
    `${BASE_URL}/Yoyaku/WgR_JikantaibetsuAkiJoukyou`,
    "next",
    "",
    [["checktime", slot.checktimeValue]],
  );

  await client.login(credentials.userId, credentials.password);
  const confirmation = await client.submitApplication(details);

  // 確定直前の照合。画面構造が変わって別のコマを掴んでいたらここで止まる。
  verifyConfirmation(confirmation, slot);

  if (options.dryRun) {
    console.log(`[dry-run] ${slotKey(slot)} は確定せずに中断しました`);
    return;
  }

  const completed = await client.confirmReservation();

  // 申込完了画面からは成否が読めないため、予約一覧で成立を確かめる。
  // ここを応答 HTML の判定で済ませていたとき、成立した予約を失敗と誤認して
  // 記録も通知も飛ばさないという事故が起きた。
  const menu = await client.openMenu(completed);
  const list = await client.openReservations(menu);
  if (!findReservation(parseReservations(list), slotKey(slot))) {
    throw new Error(
      `確定を送信しましたが予約一覧に現れませんでした（${slotKey(slot)}）。予約システムで確認してください`,
    );
  }
}
