import { describe, expect, test } from "bun:test";
import {
  matchingSlots,
  reservedCountInMonth,
  selectSlotsToReserve,
  type Wishlist,
} from "./wishlist";
import { slotKey } from "./notify";
import type { TimeSlot } from "./parser";

// 2026-08-03(月) / 08-08(土) / 08-09(日) / 09-05(土)
function slot(date: string, courtNo: string, timeRange: string): TimeSlot {
  return {
    roomCode: "00502",
    date,
    courtNo,
    timeRange,
    checktimeValue: `00502${date.replaceAll("-", "")}${courtNo}${timeRange}`,
  };
}

const SAT_9 = slot("2026-08-08", "01", "9:00～11:00");
const SAT_11 = slot("2026-08-08", "02", "11:00～13:00");
const SUN_9 = slot("2026-08-09", "01", "9:00～11:00");
const MON_9 = slot("2026-08-03", "01", "9:00～11:00");
const SAT_15 = slot("2026-08-08", "01", "15:00～17:00");
const NEXT_MONTH_SAT_9 = slot("2026-09-05", "01", "9:00～11:00");

const weekendMornings: Wishlist = {
  wishes: [{ daysOfWeek: [0, 6], timeRanges: ["9:00～11:00", "11:00～13:00"] }],
  maxPerMonth: 2,
  maxPerRun: 1,
};

function keys(slots: TimeSlot[]) {
  return slots.map(slotKey);
}

describe("reservedCountInMonth", () => {
  test("同じ暦月の予約済み件数を数える", () => {
    expect(
      reservedCountInMonth(
        ["2026-08-01 第1面 9:00～11:00", "2026-08-30 第2面 9:00～11:00"],
        "2026-08-08",
      ),
    ).toBe(2);
  });

  test("別の月は数えない", () => {
    expect(
      reservedCountInMonth(["2026-07-31 第1面 9:00～11:00"], "2026-08-08"),
    ).toBe(0);
  });

  test("予約済みが無ければ 0", () => {
    expect(reservedCountInMonth([], "2026-08-08")).toBe(0);
  });
});

describe("matchingSlots", () => {
  test("上限に関係なく一致する候補をすべて返す", () => {
    const list: Wishlist = { ...weekendMornings, maxPerRun: 1, maxPerMonth: 1 };
    const got = matchingSlots([SAT_9, SAT_11, SUN_9, MON_9], list, []);
    expect(keys(got)).toEqual([slotKey(SAT_9), slotKey(SAT_11), slotKey(SUN_9)]);
  });

  test("予約済みは候補から除く", () => {
    const got = matchingSlots([SAT_9, SAT_11], weekendMornings, [slotKey(SAT_9)]);
    expect(keys(got)).toEqual([slotKey(SAT_11)]);
  });

  test("日時の早い順に並べる", () => {
    const list: Wishlist = { wishes: [{ daysOfWeek: [6] }], maxPerMonth: 9, maxPerRun: 9 };
    expect(keys(matchingSlots([SAT_15, SAT_9], list, []))).toEqual([
      slotKey(SAT_9),
      slotKey(SAT_15),
    ]);
  });
});

describe("selectSlotsToReserve", () => {
  test("希望する曜日のコマだけを選ぶ", () => {
    const got = selectSlotsToReserve([MON_9, SAT_9], weekendMornings, []);
    expect(keys(got)).toEqual([slotKey(SAT_9)]);
  });

  test("希望する時間帯のコマだけを選ぶ", () => {
    const got = selectSlotsToReserve([SAT_15, SAT_9], weekendMornings, []);
    expect(keys(got)).toEqual([slotKey(SAT_9)]);
  });

  test("面番号を指定すればその面だけに絞る", () => {
    const courtOnly: Wishlist = {
      wishes: [{ daysOfWeek: [6], courts: [2] }],
      maxPerMonth: 5,
      maxPerRun: 5,
    };
    const got = selectSlotsToReserve([SAT_9, SAT_11], courtOnly, []);
    expect(keys(got)).toEqual([slotKey(SAT_11)]);
  });

  test("条件を省略した項目は絞り込みに使わない", () => {
    const anySaturday: Wishlist = {
      wishes: [{ daysOfWeek: [6] }],
      maxPerMonth: 9,
      maxPerRun: 9,
    };
    const got = selectSlotsToReserve([SAT_9, SAT_15, MON_9], anySaturday, []);
    expect(keys(got)).toEqual([slotKey(SAT_9), slotKey(SAT_15)]);
  });

  test("複数の希望のいずれかに一致すればよい", () => {
    const list: Wishlist = {
      wishes: [
        { daysOfWeek: [6], timeRanges: ["9:00～11:00"] },
        { daysOfWeek: [1], timeRanges: ["9:00～11:00"] },
      ],
      maxPerMonth: 9,
      maxPerRun: 9,
    };
    const got = selectSlotsToReserve([SUN_9, SAT_9, MON_9], list, []);
    expect(keys(got)).toEqual([slotKey(MON_9), slotKey(SAT_9)]);
  });

  test("日時の早い順に選ぶ（実行ごとに結果がぶれない）", () => {
    const list: Wishlist = {
      wishes: [{ daysOfWeek: [0, 6] }],
      maxPerMonth: 9,
      maxPerRun: 9,
    };
    const got = selectSlotsToReserve([SUN_9, SAT_15, SAT_9], list, []);
    expect(keys(got)).toEqual([slotKey(SAT_9), slotKey(SAT_15), slotKey(SUN_9)]);
  });

  test("予約済みのコマは選び直さない", () => {
    const got = selectSlotsToReserve([SAT_9, SAT_11], weekendMornings, [
      slotKey(SAT_9),
    ]);
    expect(keys(got)).toEqual([slotKey(SAT_11)]);
  });

  test("1 回の実行で予約する件数を maxPerRun までに抑える", () => {
    const list: Wishlist = { ...weekendMornings, maxPerRun: 1, maxPerMonth: 9 };
    const got = selectSlotsToReserve([SAT_9, SAT_11, SUN_9], list, []);
    expect(got).toHaveLength(1);
  });

  test("同月の予約済み件数が上限に達していたら何も選ばない", () => {
    const list: Wishlist = { ...weekendMornings, maxPerMonth: 2, maxPerRun: 9 };
    const got = selectSlotsToReserve([SUN_9], list, [
      slotKey(SAT_9),
      slotKey(SAT_11),
    ]);
    expect(got).toEqual([]);
  });

  test("月あたりの上限は暦月ごとに数える", () => {
    const list: Wishlist = { ...weekendMornings, maxPerMonth: 2, maxPerRun: 9 };
    // 8月は 2 件で打ち止め、9月はまだ空きがある
    const got = selectSlotsToReserve([SUN_9, NEXT_MONTH_SAT_9], list, [
      slotKey(SAT_9),
      slotKey(SAT_11),
    ]);
    expect(keys(got)).toEqual([slotKey(NEXT_MONTH_SAT_9)]);
  });

  test("同じ実行内で選んだ分も月の上限に数える", () => {
    const list: Wishlist = { ...weekendMornings, maxPerMonth: 1, maxPerRun: 9 };
    const got = selectSlotsToReserve([SAT_9, SAT_11], list, []);
    expect(got).toHaveLength(1);
  });

  test("希望が空なら何も選ばない", () => {
    const empty: Wishlist = { wishes: [], maxPerMonth: 9, maxPerRun: 9 };
    expect(selectSlotsToReserve([SAT_9], empty, [])).toEqual([]);
  });
});
