/**
 * 希望条件に一致する空きコマを選ぶ。
 *
 * 予約は取り消しに制約が伴う不可逆な操作なので、選択は決定的（同じ入力なら
 * 同じ結果）で、上限を必ず二重に効かせる:
 *   - maxPerRun:   1 回の実行で予約する件数の上限（暴走時の被害を限定する）
 *   - maxPerMonth: 暦月あたりの予約件数の上限（既存の予約済み分も数える）
 */
import { compareChronologically, slotKey } from "./notify";
import type { TimeSlot } from "./parser";

export interface Wish {
  /** 0=日 … 6=土。省略時は曜日を問わない */
  daysOfWeek?: number[];
  /** "9:00～11:00" 形式。省略時は時間帯を問わない */
  timeRanges?: string[];
  /** 面番号。省略時は面を問わない */
  courts?: number[];
}

export interface Wishlist {
  wishes: Wish[];
  maxPerMonth: number;
  maxPerRun: number;
}

/** "2026-08-08" → 曜日番号。タイムゾーンに左右されないよう UTC で解釈する。 */
function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** "2026-08-08 第1面 9:00～11:00" → "2026-08" */
function monthOf(key: string): string {
  return key.slice(0, 7);
}

/**
 * 指定した日付と同じ暦月に、すでに何件予約しているかを数える。
 *
 * LINE のボタンからの予約は selectSlotsToReserve を通らないため、
 * 実行側でも月あたりの上限を確かめる必要がある。
 */
export function reservedCountInMonth(reserved: string[], date: string): number {
  const month = date.slice(0, 7);
  return reserved.filter((key) => monthOf(key) === month).length;
}


function matches(slot: TimeSlot, wish: Wish): boolean {
  if (wish.daysOfWeek && !wish.daysOfWeek.includes(dayOfWeek(slot.date))) {
    return false;
  }
  if (wish.timeRanges && !wish.timeRanges.includes(slot.timeRange)) {
    return false;
  }
  if (wish.courts && !wish.courts.includes(Number(slot.courtNo))) {
    return false;
  }
  return true;
}

/**
 * 予約すべきコマを選ぶ。
 *
 * @param slots    今回見つかった空きコマ
 * @param wishlist 希望条件と上限
 * @param reserved 予約済みコマの識別子（slotKey 形式）
 */
/**
 * 希望条件に一致する空きコマを、上限を適用せずすべて返す（日時の早い順）。
 * 承認待ちの通知に「他の候補」を載せるために使う。
 */
export function matchingSlots(
  slots: TimeSlot[],
  wishlist: Wishlist,
  reserved: string[],
): TimeSlot[] {
  const reservedKeys = new Set(reserved);
  return slots
    .filter((slot) => !reservedKeys.has(slotKey(slot)))
    .filter((slot) => wishlist.wishes.some((wish) => matches(slot, wish)))
    .sort(compareChronologically);
}

export function selectSlotsToReserve(
  slots: TimeSlot[],
  wishlist: Wishlist,
  reserved: string[],
): TimeSlot[] {
  const countByMonth = new Map<string, number>();
  for (const key of reserved) {
    const month = monthOf(key);
    countByMonth.set(month, (countByMonth.get(month) ?? 0) + 1);
  }

  const candidates = matchingSlots(slots, wishlist, reserved);

  const selected: TimeSlot[] = [];
  for (const slot of candidates) {
    if (selected.length >= wishlist.maxPerRun) break;
    const month = slot.date.slice(0, 7);
    const used = countByMonth.get(month) ?? 0;
    if (used >= wishlist.maxPerMonth) continue;
    countByMonth.set(month, used + 1);
    selected.push(slot);
  }
  return selected;
}
