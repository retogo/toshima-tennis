import { describe, expect, test } from "bun:test";
import {
  formatStatus,
  parseModeOverride,
  parseSnapshot,
  serializeSnapshot,
} from "./runtime";
import type { Reservation } from "./reservations";
import { trackReservation } from "./tracked";

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

describe("parseModeOverride", () => {
  test("保存されている mode を読む", () => {
    expect(parseModeOverride("auto")).toBe("auto");
    expect(parseModeOverride("approve")).toBe("approve");
  });

  test("前後の空白を無視する", () => {
    expect(parseModeOverride(" approve\n")).toBe("approve");
  });

  test("未設定なら undefined（reserve.json の値を使う）", () => {
    expect(parseModeOverride("")).toBeUndefined();
  });

  test("知らない値は無視する（勝手に auto にならない側に倒す）", () => {
    // 壊れた値で例外にすると poll が止まる。既定に落とすほうが安全
    expect(parseModeOverride("AUTO")).toBeUndefined();
    expect(parseModeOverride("garbage")).toBeUndefined();
  });

  test("廃止した notify は受け付けない", () => {
    // approve との違いがボタンの有無だけで、モードとして分ける意味が無かった
    expect(parseModeOverride("notify")).toBeUndefined();
  });
});

describe("parseSnapshot / serializeSnapshot", () => {
  const snapshot = {
    takenAt: "2026-08-03T09:00:00.000Z",
    reservations: [reservation()],
  };

  test("書いて読み直すと同じ内容になる", () => {
    expect(parseSnapshot(serializeSnapshot(snapshot))).toEqual(snapshot);
  });

  test("未作成なら undefined", () => {
    expect(parseSnapshot("")).toBeUndefined();
  });

  test("壊れていたら undefined（一覧が出ないだけで済ませる）", () => {
    expect(parseSnapshot("{ not json")).toBeUndefined();
  });
});

describe("formatStatus", () => {
  const at = new Date("2026-08-03T09:30:00Z"); // JST 18:30

  test("現在のモードを人が読める言葉で出す", () => {
    expect(
      formatStatus({ mode: "auto", reservations: [], tracked: {}, cancelBufferDays: 2 }, at),
    ).toContain("自動で予約");
    expect(
      formatStatus({ mode: "approve", reservations: [], tracked: {}, cancelBufferDays: 2 }, at),
    ).toContain("押したら予約");
  });

  test("予約ごとに利用日・時間帯・使用料を出す", () => {
    const text = formatStatus(
      { mode: "auto", reservations: [reservation()], tracked: {}, cancelBufferDays: 2 },
      at,
    );
    expect(text).toContain("2026-08-24");
    expect(text).toContain("9:00～11:00");
    expect(text).toContain("2,000");
  });

  test("取消期限を出す", () => {
    const text = formatStatus(
      { mode: "auto", reservations: [reservation()], tracked: {}, cancelBufferDays: 2 },
      at,
    );
    expect(text).toContain("2026-08-17");
  });

  test("取消期限を過ぎた予約はウェブから取消できない旨を出す", () => {
    const expired = reservation({ date: "2026-08-09", timeRange: "15:00～17:00", cancelValue: undefined });
    const text = formatStatus(
      { mode: "auto", reservations: [expired], tracked: {}, cancelBufferDays: 2 },
      at,
    );
    expect(text).toContain("期限切れ");
  });

  test("自動予約かつ未承認なら、いつ自動取消されるかを出す", () => {
    const tracked = trackReservation({}, "2026-08-24 第4面 9:00～11:00", "2026-08-03");
    const text = formatStatus(
      { mode: "auto", reservations: [reservation()], tracked, cancelBufferDays: 2 },
      at,
    );
    expect(text).toContain("未承認");
    expect(text).toContain("2026-08-15"); // 期限 8/17 の 2 日前
  });

  test("承認済みならそう出す", () => {
    let tracked = trackReservation({}, "2026-08-24 第4面 9:00～11:00", "2026-08-03");
    tracked["2026-08-24 9:00～11:00"]!.approved = true;
    const text = formatStatus(
      { mode: "auto", reservations: [reservation()], tracked, cancelBufferDays: 2 },
      at,
    );
    expect(text).toContain("承認済み");
  });

  test("記録に無い予約は手動として扱い、自動取消されない旨を出す", () => {
    const text = formatStatus(
      { mode: "auto", reservations: [reservation()], tracked: {}, cancelBufferDays: 2 },
      at,
    );
    expect(text).toContain("手動");
  });

  test("予約が無ければそう伝える", () => {
    const text = formatStatus(
      { mode: "approve", reservations: [], tracked: {}, cancelBufferDays: 2 },
      at,
    );
    expect(text).toContain("予約はありません");
  });

  test("取得時刻を JST で出す（キャッシュの古さが分かるように）", () => {
    const text = formatStatus(
      {
        mode: "auto",
        reservations: [reservation()],
        tracked: {},
        cancelBufferDays: 2,
        takenAt: at,
      },
      at,
    );
    expect(text).toContain("2026-08-03 18:30 JST");
  });

  test("一覧が取れていない場合はそう伝える", () => {
    const text = formatStatus(
      { mode: "approve", reservations: undefined, tracked: {}, cancelBufferDays: 2 },
      at,
    );
    expect(text).toContain("まだ取得できていません");
  });

  test("利用日の早い順に並べる", () => {
    const text = formatStatus(
      {
        mode: "auto",
        reservations: [
          reservation({ date: "2026-08-24" }),
          reservation({ date: "2026-08-09", timeRange: "15:00～17:00" }),
        ],
        tracked: {},
        cancelBufferDays: 2,
      },
      at,
    );
    expect(text.indexOf("2026-08-09")).toBeLessThan(text.indexOf("2026-08-24"));
  });
});
