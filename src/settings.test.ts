import { describe, expect, test } from "bun:test";
import {
  MAX_PER_MONTH_CHOICES,
  TIME_RANGES,
  applySettings,
  parseSettings,
  serializeSettings,
  toggleDay,
  toggleTimeRange,
  type RuntimeSettings,
} from "./settings";
import type { ReserveConfig } from "./config";

const base: ReserveConfig = {
  mode: "approve",
  wishlist: {
    wishes: [{ daysOfWeek: [0, 6] }],
    maxPerMonth: 2,
    maxPerRun: 1,
  },
  application: { ninzu: 2, mokuteki: "404", gyoujiMeishou: "テニス" },
  cancelBufferDays: 2,
};

describe("parseSettings", () => {
  test("未設定なら空（reserve.json をそのまま使う）", () => {
    expect(parseSettings("")).toEqual({});
  });

  test("書いて読み直すと同じになる", () => {
    const settings: RuntimeSettings = {
      mode: "auto",
      maxPerMonth: 3,
      daysOfWeek: [6],
      timeRanges: ["9:00～11:00"],
    };
    expect(parseSettings(serializeSettings(settings))).toEqual(settings);
  });

  test("壊れていたら空にする（poll を止めない）", () => {
    expect(parseSettings("{ not json")).toEqual({});
  });

  test("知らない mode は落とす", () => {
    expect(parseSettings(JSON.stringify({ mode: "notify" })).mode).toBeUndefined();
  });

  test("範囲外の maxPerMonth は落とす（支出上限なので緩めない）", () => {
    expect(parseSettings(JSON.stringify({ maxPerMonth: 0 })).maxPerMonth).toBeUndefined();
    expect(parseSettings(JSON.stringify({ maxPerMonth: 99 })).maxPerMonth).toBeUndefined();
    expect(parseSettings(JSON.stringify({ maxPerMonth: 1.5 })).maxPerMonth).toBeUndefined();
  });

  test("選べる範囲の maxPerMonth は通す", () => {
    for (const n of MAX_PER_MONTH_CHOICES) {
      expect(parseSettings(JSON.stringify({ maxPerMonth: n })).maxPerMonth).toBe(n);
    }
  });

  test("曜日は 0〜6 の整数だけ通す", () => {
    expect(parseSettings(JSON.stringify({ daysOfWeek: [0, 6] })).daysOfWeek).toEqual([0, 6]);
    expect(parseSettings(JSON.stringify({ daysOfWeek: [7] })).daysOfWeek).toBeUndefined();
    expect(parseSettings(JSON.stringify({ daysOfWeek: "土" })).daysOfWeek).toBeUndefined();
  });

  test("空の曜日は保持する（＝何も選んでいない状態）", () => {
    expect(parseSettings(JSON.stringify({ daysOfWeek: [] })).daysOfWeek).toEqual([]);
  });

  test("時間帯はサイトにある枠だけ通す", () => {
    expect(parseSettings(JSON.stringify({ timeRanges: ["9:00～11:00"] })).timeRanges).toEqual([
      "9:00～11:00",
    ]);
    expect(parseSettings(JSON.stringify({ timeRanges: ["8:00～9:00"] })).timeRanges).toBeUndefined();
  });
});

describe("applySettings", () => {
  test("上書きが無ければ元の設定のまま", () => {
    expect(applySettings(base, {})).toEqual(base);
  });

  test("mode を差し替える", () => {
    expect(applySettings(base, { mode: "auto" }).mode).toBe("auto");
  });

  test("maxPerMonth を差し替える", () => {
    expect(applySettings(base, { maxPerMonth: 3 }).wishlist.maxPerMonth).toBe(3);
  });

  test("曜日と時間帯は 1 つの希望条件にまとめる", () => {
    // LINE から編集できるのは「曜日の集合 × 時間帯の集合」1 組だけ
    const applied = applySettings(base, { daysOfWeek: [6], timeRanges: ["9:00～11:00"] });
    expect(applied.wishlist.wishes).toEqual([
      { daysOfWeek: [6], timeRanges: ["9:00～11:00"] },
    ]);
  });

  test("時間帯だけ指定したら曜日は元の条件を引き継ぐ", () => {
    const applied = applySettings(base, { timeRanges: ["9:00～11:00"] });
    expect(applied.wishlist.wishes).toEqual([
      { daysOfWeek: [0, 6], timeRanges: ["9:00～11:00"] },
    ]);
  });

  test("元の設定を書き換えない", () => {
    applySettings(base, { maxPerMonth: 4, daysOfWeek: [1] });
    expect(base.wishlist.maxPerMonth).toBe(2);
    expect(base.wishlist.wishes).toEqual([{ daysOfWeek: [0, 6] }]);
  });

  test("時間帯が空なら絞り込まない（全部が対象）", () => {
    // 画面に「指定なし（全部）」と出しているので、挙動もそれに合わせる。
    // ここを「何にも一致しない」にすると、全部オフのつもりが無い状態で
    // 静かに予約も通知も止まる。
    const applied = applySettings(base, { timeRanges: [] });
    expect(applied.wishlist.wishes).toEqual([{ daysOfWeek: [0, 6] }]);
  });

  test("曜日が空なら何にも一致しない条件になる", () => {
    // 「全部オフ＝何も予約しない」。曜日を省略した状態（＝全曜日）と混同しない
    const applied = applySettings(base, { daysOfWeek: [] });
    expect(applied.wishlist.wishes[0]!.daysOfWeek).toEqual([]);
  });
});

describe("toggleDay", () => {
  test("入っていなければ足す", () => {
    expect(toggleDay([6], 0)).toEqual([0, 6]);
  });

  test("入っていれば外す", () => {
    expect(toggleDay([0, 6], 0)).toEqual([6]);
  });

  test("並びは日曜から土曜の順に保つ", () => {
    expect(toggleDay([6, 0], 3)).toEqual([0, 3, 6]);
  });

  test("全部外せる", () => {
    expect(toggleDay([6], 6)).toEqual([]);
  });
});

describe("toggleTimeRange", () => {
  test("入っていなければ足す", () => {
    expect(toggleTimeRange(["11:00～13:00"], "9:00～11:00")).toEqual([
      "9:00～11:00",
      "11:00～13:00",
    ]);
  });

  test("入っていれば外す", () => {
    expect(toggleTimeRange(["9:00～11:00"], "9:00～11:00")).toEqual([]);
  });

  test("並びは時間の早い順に保つ（文字列順だと 15:00 が 9:00 より前に来る）", () => {
    expect(toggleTimeRange(["15:00～17:00"], "9:00～11:00")).toEqual([
      "9:00～11:00",
      "15:00～17:00",
    ]);
  });

  test("サイトにない枠は無視する", () => {
    expect(toggleTimeRange([], "8:00～9:00")).toEqual([]);
  });
});

describe("TIME_RANGES", () => {
  test("サイトの 6 枠と一致する", () => {
    expect(TIME_RANGES).toEqual([
      "9:00～11:00",
      "11:00～13:00",
      "13:00～15:00",
      "15:00～17:00",
      "17:00～19:00",
      "19:00～21:00",
    ]);
  });
});
