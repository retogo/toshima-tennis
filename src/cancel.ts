/**
 * 予約の取消。
 *
 * **取消も不可逆。** 取り消したコマはすぐ他の人に取られるうえ、取消期限
 * （使用日の 1 週間前・同一曜日）を過ぎると取り直しもできない。予約の確定と
 * 同じ強さで、確定 POST の直前に画面の内容を照合する。
 *
 * 画面遷移は 予約内容の確認 →（checkCancel + next）→ 予約取消確認 → 予約取消完了。
 *
 * **取消期限の判定はサイトに任せる。** 期限を過ぎた予約には取消のチェックボックスが
 * 出ないので、`cancelValue` の有無で判断する。自前で日付を計算して判断すると、
 * サイト側の締め切りの解釈とずれたときに気づけない。
 */
import type { ToshimaClient } from "./client";
import { verifyCancellationScreen } from "./confirmation";
import {
  findReservation,
  parseReservations,
  type Reservation,
} from "./reservations";

export interface CancelOptions {
  dryRun?: boolean;
}

export type CancelOutcome =
  /** 取消した */
  | "cancelled"
  /** 予約一覧に見つからなかった（すでに取消済み・別アカウント等） */
  | "not-found"
  /** 取消期限を過ぎている（窓口・電話のみ） */
  | "deadline-passed"
  /** dryRun で確定せずに中断した */
  | "dry-run";

export interface CancelResult {
  outcome: CancelOutcome;
  reservation?: Reservation;
}

/**
 * コマの識別子（slotKey 形式）で予約を 1 件取り消す。
 *
 * @param slotKey "2026-08-24 第4面 9:00～11:00"。面は照合に使わない（サイトが
 *                庭球場のコマを区別して表示しないため）
 */
export async function cancelReservation(
  client: ToshimaClient,
  slotKey: string,
  credentials: { userId: string; password: string },
  options: CancelOptions = {},
): Promise<CancelResult> {
  const menu = await client.loginFromTop(credentials.userId, credentials.password);
  const list = await client.openReservations(menu);

  const reservation = findReservation(parseReservations(list), slotKey);
  if (!reservation) return { outcome: "not-found" };
  if (!reservation.cancelValue) {
    return { outcome: "deadline-passed", reservation };
  }

  const confirmScreen = await client.selectForCancellation(
    list,
    reservation.cancelValue,
  );

  // 別の予約を取り消してしまう事故を防ぐ。一致しなければ確定を送らない。
  verifyCancellationScreen(confirmScreen, reservation);

  if (options.dryRun) {
    console.log(`[dry-run] ${slotKey} は取消せずに中断しました`);
    return { outcome: "dry-run", reservation };
  }

  const completed = await client.confirmCancellation(confirmScreen);

  // 取消完了画面の内容では判定しない（予約の確定で同じ誤判定をしていた）。
  // 一覧から消えたことを確かめる。
  const afterMenu = await client.openMenu(completed);
  const after = await client.openReservations(afterMenu);
  if (findReservation(parseReservations(after), slotKey)) {
    throw new Error(
      `取消を送信しましたが予約一覧に残っています（${slotKey}）。予約システムで確認してください`,
    );
  }

  return { outcome: "cancelled", reservation };
}
