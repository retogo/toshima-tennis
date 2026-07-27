/**
 * 申込確認画面の照合。
 *
 * 予約の確定は取り消しに施設規定（使用日の 1 週間前まで／以降は窓口・電話のみ、
 * キャンセル料あり）が伴う不可逆な操作なので、確定 POST を送る直前に
 * 「画面に出ている予約内容が、こちらが押さえたいコマと一致しているか」を照合する。
 *
 * サイトの画面構造が変わって別のコマを掴んでいた場合、ここで止める。
 */
import type { TimeSlot } from "./parser";

const FULL_WIDTH_DIGITS = "０１２３４５６７８９";

/** "2026-08-03" → "2026/8/3"（サイト表示はゼロ埋めなし） */
export function formatSiteDate(date: string): string {
  const [year, month, day] = date.split("-");
  return `${year}/${Number(month)}/${Number(day)}`;
}

/** "01" → "１面"（サイト表示は全角） */
export function formatSiteCourt(courtNo: string): string {
  const digits = String(Number(courtNo))
    .split("")
    .map((d) => FULL_WIDTH_DIGITS[Number(d)])
    .join("");
  return `${digits}面`;
}

/**
 * 申込確認画面が、予約したいコマを表示しているか確かめる。
 * 一致しなければ例外を投げ、確定 POST に進ませない。
 */
export function verifyConfirmation(html: string, slot: TimeSlot): void {
  if (!html.includes("__doPostBack('next','')")) {
    throw new Error(
      "申込確認画面が取得できていません（「申込」ボタンが見つかりません）",
    );
  }

  const expectedDate = formatSiteDate(slot.date);
  if (!html.includes(expectedDate)) {
    throw new Error(
      `申込確認画面の利用日が一致しません（期待: ${expectedDate}）`,
    );
  }

  if (!html.includes(slot.timeRange)) {
    throw new Error(
      `申込確認画面の時間帯が一致しません（期待: ${slot.timeRange}）`,
    );
  }

  const expectedCourt = formatSiteCourt(slot.courtNo);
  if (!html.includes(expectedCourt)) {
    throw new Error(
      `申込確認画面の面が一致しません（期待: ${expectedCourt}、時間帯: ${slot.timeRange}）`,
    );
  }
}

/**
 * 取消手続きの期限＝使用日の 1 週間前（同一曜日）。
 * これを過ぎると窓口・電話での取消になり、キャンセル料が発生する。
 */
export function cancellationDeadline(date: string): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - 7);
  return at.toISOString().slice(0, 10);
}
