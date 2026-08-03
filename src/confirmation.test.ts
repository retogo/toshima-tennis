import { describe, expect, test } from "bun:test";
import {
  formatSiteDate,
  verifyCancellationScreen,
  verifyConfirmation,
  cancellationDeadline,
} from "./confirmation";
import type { TimeSlot } from "./parser";

const TARGET: TimeSlot = {
  roomCode: "00502",
  date: "2026-08-03",
  courtNo: "01",
  timeRange: "9:00～11:00",
  checktimeValue: "0050220260803019:00～11:00",
};

/**
 * 申込確認画面の表示を模した最小のテキスト。
 *
 * 室場名の「１面」は**どのコマを選んでも常にこの表示**になる。サイトは 4 つの
 * コマ（checktime の面番号 01〜04）を区別して表示しない。
 */
function confirmationHtml(
  overrides: { date?: string; time?: string; room?: string } = {},
) {
  const date = overrides.date ?? "2026/8/3(月)";
  const time = overrides.time ?? "9:00～11:00";
  const room = overrides.room ?? "総合体育場 庭球場 １面";
  return `<div>${room}</div>
    <div>利用日 ${date}</div>
    <div>時間帯 ${time}</div>
    <div>施設使用料 2,000 円</div>
    <input type="button" value=" 申込" onclick="javascript:__doPostBack('next','')" />`;
}

describe("formatSiteDate", () => {
  test("ゼロ埋めなしのスラッシュ区切りにする", () => {
    expect(formatSiteDate("2026-08-03")).toBe("2026/8/3");
  });

  test("2 桁の月日もそのまま扱える", () => {
    expect(formatSiteDate("2026-12-25")).toBe("2026/12/25");
  });
});

describe("verifyConfirmation", () => {
  test("表示内容が予約したいコマと一致すれば通す", () => {
    expect(() => verifyConfirmation(confirmationHtml(), TARGET)).not.toThrow();
  });

  test("日付が違えば確定させない", () => {
    expect(() =>
      verifyConfirmation(confirmationHtml({ date: "2026/8/10(月)" }), TARGET),
    ).toThrow(/利用日/);
  });

  test("時間帯が違えば確定させない", () => {
    expect(() =>
      verifyConfirmation(confirmationHtml({ time: "11:00～13:00" }), TARGET),
    ).toThrow(/時間帯/);
  });

  test("面は照合しない（サイトがコマごとに区別して表示しないため）", () => {
    // 実サイトは checktime の面番号 01〜04 のどれを選んでも室場名を「１面」と
    // 表示する。面を照合すると 2〜4 面の予約が必ず中断してしまう。
    const fourth: TimeSlot = { ...TARGET, courtNo: "04" };
    expect(() => verifyConfirmation(confirmationHtml(), fourth)).not.toThrow();
  });

  test("別の施設・室場を表示していれば確定させない", () => {
    // 面が照合できない代わりに、施設と室場までは照合する
    expect(() =>
      verifyConfirmation(confirmationHtml({ room: "豊島体育館 体育室" }), TARGET),
    ).toThrow(/庭球場/);
  });

  test("そもそも申込確認画面でなければ確定させない", () => {
    expect(() => verifyConfirmation("<div>エラー</div>", TARGET)).toThrow(
      /申込確認画面/,
    );
  });

  test("例外メッセージに期待値と実際の表示の両方を含める", () => {
    try {
      verifyConfirmation(confirmationHtml({ time: "11:00～13:00" }), TARGET);
      throw new Error("失敗するはず");
    } catch (e) {
      expect((e as Error).message).toContain("9:00～11:00");
    }
  });
});

describe("cancellationDeadline", () => {
  test("使用日の 1 週間前（同一曜日）を返す", () => {
    expect(cancellationDeadline("2026-08-03")).toBe("2026-07-27");
  });

  test("月をまたぐ場合も正しく引く", () => {
    expect(cancellationDeadline("2026-09-02")).toBe("2026-08-26");
  });
});

const cancelHtml = await Bun.file("fixtures/cancel-confirm.html").text();

describe("verifyCancellationScreen", () => {
  const TARGET_RESERVATION = { date: "2026-08-24", timeRange: "9:00～11:00" };

  test("取消確認画面の内容が対象と一致すれば通す", () => {
    expect(() =>
      verifyCancellationScreen(cancelHtml, TARGET_RESERVATION),
    ).not.toThrow();
  });

  test("利用日が違えば取消させない", () => {
    expect(() =>
      verifyCancellationScreen(cancelHtml, {
        date: "2026-08-31",
        timeRange: "9:00～11:00",
      }),
    ).toThrow(/利用日/);
  });

  test("時間帯が違えば取消させない", () => {
    expect(() =>
      verifyCancellationScreen(cancelHtml, {
        date: "2026-08-24",
        timeRange: "13:00～15:00",
      }),
    ).toThrow(/時間帯/);
  });

  test("そもそも取消確認画面でなければ取消させない", () => {
    // 「取消」ボタンが無い画面に確定を送らない
    expect(() =>
      verifyCancellationScreen("<div>予約はありません</div>", TARGET_RESERVATION),
    ).toThrow(/取消確認画面/);
  });
});
