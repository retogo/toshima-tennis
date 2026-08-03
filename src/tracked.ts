/**
 * このツールが自動で取った予約と、その承認状態。
 *
 * サイトは「誰が何のために取ったか」を持たないので、自動取消の対象を決めるには
 * ツール側の記録が必要になる。
 *
 * **記録に無い予約は絶対に取り消さない。** 利用者が自分で取った予約を勝手に
 * 取り消してしまう事故を防ぐための一番大事な性質。実際に、このツールが記録して
 * いない手動予約が 1 件存在していた。
 *
 * キーは「利用日 時間帯」。サイトが庭球場のコマを面で区別して表示しないため、
 * 面はキーに使えない（`src/reservations.ts` の reservationKey と同じ）。
 */
import { cancellationDeadline } from "./confirmation";
import { reservationKey, type Reservation } from "./reservations";

export interface TrackedReservation {
  /** 通知やボタンに出すコマ名（"2026-08-24 第4面 9:00～11:00"） */
  slotKey: string;
  /** 自動予約した日（JST の YYYY-MM-DD） */
  reservedOn: string;
  /** 承認済みなら自動取消の対象外 */
  approved: boolean;
}

/** キーは "2026-08-24 9:00～11:00" */
export type TrackedState = Record<string, TrackedReservation>;

/** slotKey → 状態のキー。面を落とす。 */
function keyOf(slotKey: string): string {
  const m = slotKey.match(/^(\d{4}-\d{2}-\d{2}) 第\d+面 (.+)$/);
  return m ? `${m[1]} ${m[2]}` : slotKey;
}

/**
 * 保存してある状態を読む。
 *
 * **壊れていたら例外にする。** 空とみなすと承認済みの予約が未承認扱いになり、
 * 承認したのに取り消される。
 */
export function parseTracked(text: string): TrackedState {
  if (text.trim() === "") return {};
  return JSON.parse(text) as TrackedState;
}

export function serializeTracked(state: TrackedState): string {
  return JSON.stringify(state, null, 2);
}

/** 自動予約したコマを未承認として記録する。 */
export function trackReservation(
  state: TrackedState,
  slotKey: string,
  reservedOn: string,
): TrackedState {
  return {
    ...state,
    [keyOf(slotKey)]: { slotKey, reservedOn, approved: false },
  };
}

/** 承認する。以後この予約は自動取消の対象にならない。 */
export function approveTracked(
  state: TrackedState,
  slotKey: string,
): TrackedState {
  const key = keyOf(slotKey);
  const tracked = state[key];
  if (!tracked) return state;
  return { ...state, [key]: { ...tracked, approved: true } };
}

/** 取消した（または手放した）コマを記録から消す。 */
export function forgetTracked(
  state: TrackedState,
  slotKey: string,
): TrackedState {
  const { [keyOf(slotKey)]: _removed, ...rest } = state;
  return rest;
}

/** "2026-08-17" から days 日引く。 */
function minusDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - days);
  return at.toISOString().slice(0, 10);
}

/**
 * 承認の猶予が確保できるコマかどうか。**自動予約してよいかの判断に使う。**
 *
 * 申込期間はサイト側で使用日の 7 日前に開き（それより前は「申込期間外」）、
 * 取消期限も使用日の 7 日前。**両者がちょうど重なる**ため、予約できるようになった
 * 直後のコマには承認の猶予が無い。
 *
 * 猶予が無いまま自動予約すると次の 2 つが起きる。
 *   - 予約した直後に自動取消の対象になり、承認する間もなく取り消される
 *   - 最短（使用日が 7 日後）の場合は取消期限が当日なので、日次ジョブが
 *     取り逃すと二度と取り消せず、承認していない予約に費用が確定する
 *
 * そのため自動取消の開始日が**未来にあること**を条件にする。
 */
export function hasApprovalWindow(
  useDate: string,
  today: string,
  bufferDays: number,
): boolean {
  return minusDays(cancellationDeadline(useDate), bufferDays) > today;
}

/**
 * 承認されないまま取消期限が近づいた予約を返す。
 *
 * 期限当日に取り消すのは危険で、ジョブが失敗すると期限を超過して窓口・電話での
 * キャンセル料が発生する。`bufferDays` 日前から対象にして再試行の余地を残す。
 *
 * 取消できるかどうかはサイトの判断に従う（`cancelValue` の有無）。期限を過ぎた
 * 予約に取消を送っても通らないため、対象から外す。
 *
 * @param today JST の YYYY-MM-DD
 */
export function dueForCancellation(
  state: TrackedState,
  reservations: Reservation[],
  today: string,
  bufferDays: number,
): TrackedReservation[] {
  const bySiteKey = new Map(reservations.map((r) => [reservationKey(r), r]));

  return Object.entries(state)
    .filter(([key, tracked]) => {
      if (tracked.approved) return false;

      // 記録にあっても、サイトに無い／取消を受け付けないものは対象外
      const reservation = bySiteKey.get(key);
      if (!reservation?.cancelValue) return false;

      const startCancellingOn = minusDays(
        cancellationDeadline(reservation.date),
        bufferDays,
      );
      return today >= startCancellingOn;
    })
    .map(([, tracked]) => tracked);
}
