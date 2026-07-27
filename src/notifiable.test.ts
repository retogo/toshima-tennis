import { describe, expect, test } from "bun:test";
import { notifiableSlots } from "./notifiable";
import { slotKey } from "./notify";
import type { Wishlist } from "./wishlist";
import type { TimeSlot } from "./parser";

function slot(date: string, courtNo: string, timeRange: string): TimeSlot {
  return {
    roomCode: "00502",
    date,
    courtNo,
    timeRange,
    checktimeValue: "x",
  };
}

const SAT = slot("2026-08-08", "01", "9:00～11:00");
const MON = slot("2026-08-03", "01", "9:00～11:00");
const weekend: Wishlist = {
  wishes: [{ daysOfWeek: [0, 6] }],
  maxPerMonth: 2,
  maxPerRun: 1,
};

describe("notifiableSlots", () => {
  test("希望条件があれば、一致するコマだけを通知対象にする", () => {
    // 平日の空きが増減しても通知が鳴らないようにするのが狙い
    const got = notifiableSlots([MON, SAT], weekend, []);
    expect(got.map(slotKey)).toEqual([slotKey(SAT)]);
  });

  test("希望条件が無ければ全ての空きを通知対象にする", () => {
    const got = notifiableSlots([MON, SAT], undefined, []);
    expect(got.map(slotKey)).toEqual([slotKey(MON), slotKey(SAT)]);
  });

  test("予約済みのコマは通知対象から外す", () => {
    const got = notifiableSlots([SAT], weekend, [slotKey(SAT)]);
    expect(got).toEqual([]);
  });

  test("希望条件なしでも日時の早い順に並べる", () => {
    const late = slot("2026-08-08", "01", "15:00～17:00");
    const early = slot("2026-08-08", "01", "9:00～11:00");
    const got = notifiableSlots([late, early], undefined, []);
    expect(got.map(slotKey)).toEqual([slotKey(early), slotKey(late)]);
  });
});
