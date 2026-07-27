import { describe, expect, test } from "bun:test";
import {
  formatSiteDate,
  formatSiteCourt,
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

/** 申込確認画面の表示を模した最小のテキスト。 */
function confirmationHtml(
  overrides: { date?: string; time?: string; court?: string } = {},
) {
  const date = overrides.date ?? "2026/8/3(月)";
  const time = overrides.time ?? "9:00～11:00";
  const court = overrides.court ?? "１面";
  return `<div>総合体育場 庭球場 ${court}</div>
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

describe("formatSiteCourt", () => {
  test("面番号を全角にする（サイト表示が「１面」のため）", () => {
    expect(formatSiteCourt("01")).toBe("１面");
    expect(formatSiteCourt("4")).toBe("４面");
  });

  test("2 桁の面番号も各桁を全角にする", () => {
    expect(formatSiteCourt("12")).toBe("１２面");
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

  test("面が違えば確定させない", () => {
    expect(() =>
      verifyConfirmation(confirmationHtml({ court: "２面" }), TARGET),
    ).toThrow(/面/);
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
