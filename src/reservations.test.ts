import { describe, expect, test } from "bun:test";
import { parseReservations, findReservation, reservationKey } from "./reservations";

const listHtml = await Bun.file("fixtures/yoyaku-list.html").text();

describe("parseReservations", () => {
  test("予約内容の確認画面から予約を読み取る", () => {
    const reservations = parseReservations(listHtml);
    expect(reservations).toHaveLength(2);
  });

  test("利用日・時間帯・使用料・状態を取り出す", () => {
    const [first] = parseReservations(listHtml);
    expect(first).toMatchObject({
      date: "2026-08-09",
      timeRange: "15:00～17:00",
      feeYen: 2000,
      status: "本予約",
    });
  });

  test("取消可能な予約は取消の値を持つ", () => {
    // 期限内の予約には checkCancel のチェックボックスが出る
    const cancellable = parseReservations(listHtml).find((r) => r.date === "2026-08-24");
    expect(cancellable?.cancelValue).toBe("1");
  });

  test("取消期限を過ぎた予約は取消の値を持たない", () => {
    // サイトが取消のチェックボックス自体を出さない。これが期限判定の根拠になる
    const expired = parseReservations(listHtml).find((r) => r.date === "2026-08-09");
    expect(expired?.cancelValue).toBeUndefined();
  });

  test("予約が無い画面では空になる", () => {
    expect(parseReservations("<div>予約はありません</div>")).toEqual([]);
  });
});

describe("reservationKey", () => {
  test("利用日と時間帯で識別する（面はサイトが区別しないため含めない）", () => {
    expect(
      reservationKey({
        date: "2026-08-24",
        timeRange: "9:00～11:00",
        feeYen: 2000,
        status: "本予約",
      }),
    ).toBe("2026-08-24 9:00～11:00");
  });
});

describe("findReservation", () => {
  const reservations = parseReservations(listHtml);

  test("コマの識別子から予約を引ける", () => {
    // 通知やボタンが持つ slotKey は「第N面」を含むが、サイト側は面を区別しない。
    // 利用日と時間帯で突き合わせる。
    const found = findReservation(reservations, "2026-08-24 第4面 9:00～11:00");
    expect(found?.date).toBe("2026-08-24");
    expect(found?.cancelValue).toBe("1");
  });

  test("一致する予約が無ければ undefined", () => {
    expect(
      findReservation(reservations, "2026-12-25 第1面 9:00～11:00"),
    ).toBeUndefined();
  });

  test("面番号が違っても同じ利用日・時間帯なら引ける", () => {
    expect(findReservation(reservations, "2026-08-24 第1面 9:00～11:00")?.date).toBe(
      "2026-08-24",
    );
  });
});
