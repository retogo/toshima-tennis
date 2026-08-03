import { describe, expect, test } from "bun:test";
import { parseConfig } from "./config";
import { MOKUTEKI } from "./client";

const minimal = {
  wishes: [{ daysOfWeek: [0, 6], timeRanges: ["9:00～11:00"] }],
  maxPerMonth: 2,
  maxPerRun: 1,
  ninzu: 4,
};

describe("parseConfig: mode", () => {
  test("既定は approve（人が押して初めて予約する側に倒す）", () => {
    expect(parseConfig(JSON.stringify(minimal)).mode).toBe("approve");
  });

  test("approve / auto を指定できる", () => {
    expect(parseConfig(JSON.stringify({ ...minimal, mode: "approve" })).mode).toBe(
      "approve",
    );
    expect(parseConfig(JSON.stringify({ ...minimal, mode: "auto" })).mode).toBe(
      "auto",
    );
  });

  test("知らないモードは弾く", () => {
    expect(() =>
      parseConfig(JSON.stringify({ ...minimal, mode: "yolo" })),
    ).toThrow(/mode/);
  });
});

describe("parseConfig", () => {
  test("希望条件と上限、利用人数を読む", () => {
    const config = parseConfig(JSON.stringify(minimal));
    expect(config.wishlist.maxPerMonth).toBe(2);
    expect(config.wishlist.maxPerRun).toBe(1);
    expect(config.application.ninzu).toBe(4);
  });

  test("行事名称と使用目的は既定値を持つ", () => {
    const config = parseConfig(JSON.stringify(minimal));
    expect(config.application.gyoujiMeishou).toBe("テニス");
    expect(config.application.mokuteki).toBe(MOKUTEKI.tennis);
  });

  test("行事名称と使用目的は上書きできる", () => {
    const config = parseConfig(
      JSON.stringify({
        ...minimal,
        gyoujiMeishou: "テニス練習",
        mokuteki: "softTennis",
      }),
    );
    expect(config.application.gyoujiMeishou).toBe("テニス練習");
    expect(config.application.mokuteki).toBe(MOKUTEKI.softTennis);
  });

  test("利用人数が無ければ何を設定すべきか示して失敗する", () => {
    const { ninzu, ...withoutNinzu } = minimal;
    expect(() => parseConfig(JSON.stringify(withoutNinzu))).toThrow(/ninzu/);
  });

  test("利用人数が 1 未満なら弾く", () => {
    expect(() => parseConfig(JSON.stringify({ ...minimal, ninzu: 0 }))).toThrow(
      /ninzu/,
    );
  });

  test("上限が無ければ弾く（無制限に予約されるのを防ぐ）", () => {
    const { maxPerRun, ...withoutMax } = minimal;
    expect(() => parseConfig(JSON.stringify(withoutMax))).toThrow(/maxPerRun/);
  });

  test("希望条件が空なら弾く（何も予約しない設定は事故のもと）", () => {
    expect(() =>
      parseConfig(JSON.stringify({ ...minimal, wishes: [] })),
    ).toThrow(/wishes/);
  });

  test("曜日は 0〜6 の範囲だけ受け付ける", () => {
    expect(() =>
      parseConfig(JSON.stringify({ ...minimal, wishes: [{ daysOfWeek: [7] }] })),
    ).toThrow(/daysOfWeek/);
  });

  test("知らない使用目的は弾く", () => {
    expect(() =>
      parseConfig(JSON.stringify({ ...minimal, mokuteki: "野球" })),
    ).toThrow(/mokuteki/);
  });

  test("JSON として壊れていれば分かるように失敗する", () => {
    expect(() => parseConfig("{ちがう")).toThrow(/JSON/);
  });
});

describe("cancelBufferDays", () => {
  const base = {
    wishes: [{ daysOfWeek: [0, 6] }],
    maxPerMonth: 2,
    maxPerRun: 1,
    ninzu: 2,
  };

  test("省略時は 2 日前（ジョブ失敗時に翌日再試行できる）", () => {
    expect(parseConfig(JSON.stringify(base)).cancelBufferDays).toBe(2);
  });

  test("指定した日数を使う", () => {
    expect(
      parseConfig(JSON.stringify({ ...base, cancelBufferDays: 3 }))
        .cancelBufferDays,
    ).toBe(3);
  });

  test("0 以下は受け付けない（期限当日の取消は失敗すると取り返せない）", () => {
    expect(() =>
      parseConfig(JSON.stringify({ ...base, cancelBufferDays: 0 })),
    ).toThrow(/cancelBufferDays/);
  });

  test("取消期限（7 日）以上は受け付けない（予約直後に取消してしまう）", () => {
    expect(() =>
      parseConfig(JSON.stringify({ ...base, cancelBufferDays: 7 })),
    ).toThrow(/cancelBufferDays/);
  });
});
