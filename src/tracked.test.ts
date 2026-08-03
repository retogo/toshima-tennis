import { describe, expect, test } from "bun:test";
import {
  approveTracked,
  dueForCancellation,
  forgetTracked,
  hasApprovalWindow,
  parseTracked,
  serializeTracked,
  trackReservation,
  type TrackedState,
} from "./tracked";
import type { Reservation } from "./reservations";

const SLOT = "2026-08-24 第4面 9:00～11:00";
/** サイト側は面を区別しないため、状態のキーは「利用日 時間帯」になる */
const KEY = "2026-08-24 9:00～11:00";

function reservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    date: "2026-08-24",
    timeRange: "9:00～11:00",
    feeYen: 2000,
    status: "本予約",
    cancelValue: "1",
    ...overrides,
  };
}

describe("parseTracked / serializeTracked", () => {
  test("空の内容は空の状態になる（初回実行）", () => {
    expect(parseTracked("")).toEqual({});
  });

  test("書いて読み直すと同じ状態になる", () => {
    const state = trackReservation({}, SLOT, "2026-08-03");
    expect(parseTracked(serializeTracked(state))).toEqual(state);
  });

  test("壊れた内容は例外にする（黙って予約を取りこぼさない）", () => {
    // 状態を空とみなすと、承認済みの予約を未承認扱いで取消しかねない
    expect(() => parseTracked("{ not json")).toThrow();
  });
});

describe("trackReservation", () => {
  test("利用日と時間帯をキーに、未承認として記録する", () => {
    const state = trackReservation({}, SLOT, "2026-08-03");
    expect(state[KEY]).toEqual({
      slotKey: SLOT,
      reservedOn: "2026-08-03",
      approved: false,
    });
  });
});

describe("approveTracked", () => {
  test("承認すると自動取消の対象から外れる", () => {
    const state = approveTracked(trackReservation({}, SLOT, "2026-08-03"), SLOT);
    expect(state[KEY]!.approved).toBe(true);
  });

  test("知らないコマを承認しても壊れない", () => {
    expect(approveTracked({}, SLOT)).toEqual({});
  });
});

describe("forgetTracked", () => {
  test("取消したコマは記録から消す", () => {
    const state = forgetTracked(trackReservation({}, SLOT, "2026-08-03"), SLOT);
    expect(state).toEqual({});
  });
});

describe("dueForCancellation", () => {
  const tracked = trackReservation({}, SLOT, "2026-08-03");

  test("取消期限のバッファ日前に達したら対象になる", () => {
    // 使用日 8/24 → 取消期限 8/17 → バッファ 2 日なので 8/15 から対象
    expect(
      dueForCancellation(tracked, [reservation()], "2026-08-15", 2),
    ).toHaveLength(1);
  });

  test("バッファ日前より手前では対象にしない（承認の猶予を残す）", () => {
    expect(
      dueForCancellation(tracked, [reservation()], "2026-08-14", 2),
    ).toEqual([]);
  });

  test("承認済みは対象にしない", () => {
    const approved = approveTracked(tracked, SLOT);
    expect(
      dueForCancellation(approved, [reservation()], "2026-08-15", 2),
    ).toEqual([]);
  });

  test("記録に無い予約は絶対に対象にしない（手動で取った予約を守る）", () => {
    // 利用者が自分で取った予約をツールが勝手に取り消してはいけない
    const manual = reservation({ date: "2026-08-09", timeRange: "15:00～17:00" });
    expect(dueForCancellation({}, [manual], "2026-08-15", 2)).toEqual([]);
    expect(dueForCancellation(tracked, [manual], "2026-08-15", 2)).toEqual([]);
  });

  test("サイトが取消を受け付けない予約は対象にしない", () => {
    // 期限を過ぎるとチェックボックスが出ない。送っても取消できない
    const expired = reservation({ cancelValue: undefined });
    expect(dueForCancellation(tracked, [expired], "2026-08-20", 2)).toEqual([]);
  });

  test("期限当日でも（まだ取消可能なら）対象にする", () => {
    expect(
      dueForCancellation(tracked, [reservation()], "2026-08-17", 2),
    ).toHaveLength(1);
  });

  test("取消に使う slotKey を返す", () => {
    const [due] = dueForCancellation(tracked, [reservation()], "2026-08-15", 2);
    expect(due?.slotKey).toBe(SLOT);
  });

  test("複数の未承認予約をまとめて返す", () => {
    let state = trackReservation({}, SLOT, "2026-08-03");
    state = trackReservation(state, "2026-08-25 第1面 13:00～15:00", "2026-08-03");
    const reservations = [
      reservation(),
      reservation({ date: "2026-08-25", timeRange: "13:00～15:00", cancelValue: "2" }),
    ];
    expect(dueForCancellation(state, reservations, "2026-08-16", 2)).toHaveLength(2);
  });
});

describe("状態の型", () => {
  test("TrackedState は JSON でそのまま保存できる", () => {
    const state: TrackedState = trackReservation({}, SLOT, "2026-08-03");
    expect(() => JSON.stringify(state)).not.toThrow();
  });
});

describe("hasApprovalWindow", () => {
  // 申込期間は使用日の 7 日前に開き、取消期限も使用日の 7 日前。
  // 両者が重なるため、近い日のコマには承認の猶予が無い。
  test("自動取消の開始日が未来なら猶予あり", () => {
    expect(hasApprovalWindow("2026-08-13", "2026-08-03", 2)).toBe(true);
  });

  test("自動取消の開始日が今日なら猶予なし（同日に取り消される）", () => {
    expect(hasApprovalWindow("2026-08-12", "2026-08-03", 2)).toBe(false);
  });

  test("自動取消の開始日が過去なら猶予なし", () => {
    expect(hasApprovalWindow("2026-08-11", "2026-08-03", 2)).toBe(false);
  });

  test("申込可能な最短（使用日が 7 日後）は猶予なし", () => {
    // 取消期限が今日になるため、取り逃すと二度と取り消せない
    expect(hasApprovalWindow("2026-08-10", "2026-08-03", 2)).toBe(false);
  });

  test("バッファを広げると必要な余裕も増える", () => {
    expect(hasApprovalWindow("2026-08-13", "2026-08-03", 3)).toBe(false);
    expect(hasApprovalWindow("2026-08-14", "2026-08-03", 3)).toBe(true);
  });

  test("十分先のコマは猶予あり", () => {
    expect(hasApprovalWindow("2026-09-05", "2026-08-03", 2)).toBe(true);
  });
});
