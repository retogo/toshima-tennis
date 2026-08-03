/**
 * 「予約内容の確認・取消」画面の読み取り。
 *
 * **予約の真実はサイト側にある。** 状態ファイル（reserved.txt）はこのツールが
 * 取った分しか知らないため、手動で取った予約や記録漏れを数え落とす。実際に
 * 8/9 の予約が記録されていない状態が起きていた。月上限の判定・予約成立の確認・
 * 取消はすべてこの画面を根拠にする。
 *
 * **取消可否もこの画面が教えてくれる。** 取消期限（使用日の 1 週間前）を過ぎた
 * 予約には取消のチェックボックスが出ない。期限を自前で計算して判断するのではなく、
 * チェックボックスの有無を見る。
 */
import { parse, type HTMLElement } from "node-html-parser";

export interface Reservation {
  /** 利用日（"2026-08-24"） */
  date: string;
  /** 時間帯（"9:00～11:00"）。時が 1 桁になる */
  timeRange: string;
  /** 施設使用料（円） */
  feeYen: number;
  /** 「本予約」など、画面に出ている状態 */
  status: string;
  /**
   * 取消するときに checkCancel へ渡す値。
   * **無い場合は取消期限を過ぎている**（窓口・電話のみ）。
   */
  cancelValue?: string;
}

/** "2026/8/24(月)" → "2026-08-24" */
function parseSiteDate(text: string): string | undefined {
  const m = text.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (!m) return undefined;
  const [, year, month, day] = m;
  return `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
}

/** その行の <dl class="..."> の値（dd）を取る。 */
function value(item: HTMLElement, className: string): string {
  return item.querySelector(`dl.${className} dd`)?.text.trim() ?? "";
}

export function parseReservations(html: string): Reservation[] {
  const reservations: Reservation[] = [];

  // #body の外（登録済施設グループのダイアログ）にも同じ形の行があるため範囲を絞る
  for (const item of parse(html).querySelectorAll("#body div.item")) {
    const date = parseSiteDate(value(item, "date"));
    if (!date) continue; // 見出し行

    const cancelBox = item.querySelector('dl.cancel input[name="checkCancel"]');

    reservations.push({
      date,
      timeRange: value(item, "time"),
      feeYen: Number(value(item, "price").replace(/[^\d]/g, "")),
      status: value(item, "status"),
      ...(cancelBox
        ? { cancelValue: cancelBox.getAttribute("value")! }
        : {}),
    });
  }

  return reservations;
}

/**
 * 予約を「利用日 時間帯」で識別する。
 *
 * 面を含めない。サイトは庭球場の 4 コマを区別して表示しないため、予約一覧から
 * 面を読み取れない（`src/confirmation.ts` の verifyConfirmation と同じ理由）。
 */
export function reservationKey(reservation: Reservation): string {
  return `${reservation.date} ${reservation.timeRange}`;
}

/**
 * コマの識別子（slotKey 形式 "2026-08-24 第4面 9:00～11:00"）から予約を引く。
 * 面は突き合わせに使えないので、利用日と時間帯で照合する。
 */
export function findReservation(
  reservations: Reservation[],
  slotKey: string,
): Reservation | undefined {
  const m = slotKey.match(/^(\d{4}-\d{2}-\d{2}) 第\d+面 (.+)$/);
  if (!m) return undefined;
  const wanted = `${m[1]} ${m[2]}`;
  return reservations.find((r) => reservationKey(r) === wanted);
}
