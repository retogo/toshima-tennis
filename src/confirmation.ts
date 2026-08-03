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

/** "2026-08-03" → "2026/8/3"（サイト表示はゼロ埋めなし） */
export function formatSiteDate(date: string): string {
  const [year, month, day] = date.split("-");
  return `${year}/${Number(month)}/${Number(day)}`;
}

/** 照合する施設・室場。サイトはこの並びで見出しに出す。 */
const EXPECTED_ROOM = "総合体育場 庭球場";

/**
 * 申込確認画面が、予約したいコマを表示しているか確かめる。
 * 一致しなければ例外を投げ、確定 POST に進ませない。
 *
 * **面は照合できない。** サイトは庭球場の 4 コマ（checktime の面番号 01〜04）を
 * 区別して表示せず、室場名をどのコマでも「庭球場 １面」と出す。日別・時間帯別・
 * 申込確認・予約内容の確認、いずれの画面でも同じ。面を照合すると 2〜4 面の予約が
 * 必ず中断するため、照合対象から外している（実測で第 4 面の予約が
 * 「期待: ４面」で止まった）。
 *
 * 代わりに施設・室場までは照合する。確定してよいかの判断に効くのは
 * 施設・利用日・時間帯で、これらはすべて画面から確認できる。面が入れ替わった
 * 場合の影響は「同じ施設・同じ日・同じ時間の別のコマ」に留まる。
 */
export function verifyConfirmation(html: string, slot: TimeSlot): void {
  if (!html.includes("__doPostBack('next','')")) {
    throw new Error(
      "申込確認画面が取得できていません（「申込」ボタンが見つかりません）",
    );
  }

  if (!html.includes(EXPECTED_ROOM)) {
    throw new Error(
      `申込確認画面の施設・室場が一致しません（期待: ${EXPECTED_ROOM}）`,
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
}

/**
 * 予約取消確認画面が、取り消したい予約を表示しているか確かめる。
 * 一致しなければ例外を投げ、取消の確定 POST に進ませない。
 *
 * **取消も不可逆。** 取り消したコマはすぐ他の人に取られるうえ、取消期限を過ぎると
 * 取り直しもできない。別の予約を取り消してしまう事故を防ぐため、予約の確定と
 * 同じ強さで照合する。面を照合できない理由は verifyConfirmation と同じ。
 */
export function verifyCancellationScreen(
  html: string,
  reservation: { date: string; timeRange: string },
): void {
  if (!html.includes("__doPostBack('next','')")) {
    throw new Error(
      "取消確認画面が取得できていません（「取消」ボタンが見つかりません）",
    );
  }

  if (!html.includes(EXPECTED_ROOM)) {
    throw new Error(
      `取消確認画面の施設・室場が一致しません（期待: ${EXPECTED_ROOM}）`,
    );
  }

  const expectedDate = formatSiteDate(reservation.date);
  if (!html.includes(expectedDate)) {
    throw new Error(
      `取消確認画面の利用日が一致しません（期待: ${expectedDate}）`,
    );
  }

  if (!html.includes(reservation.timeRange)) {
    throw new Error(
      `取消確認画面の時間帯が一致しません（期待: ${reservation.timeRange}）`,
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
