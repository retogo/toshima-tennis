import { describe, expect, test } from "bun:test";
import {
  extractToken,
  parseDailyAvailability,
  parseFacilities,
  parseTimeSlots,
} from "./parser";

const fixture = (name: string) => Bun.file(`fixtures/${name}`).text();

describe("extractToken", () => {
  test("StartPage から __RequestVerificationToken を抽出する", async () => {
    const html = await fixture("startpage.html");
    const token = extractToken(html);
    expect(token).toStartWith("DUMMYTOKEN");
    expect(token.length).toBeGreaterThan(100);
  });
});

describe("parseFacilities", () => {
  test("施設検索ページから施設コードと施設名を抽出する", async () => {
    const html = await fixture("shisetsu-kensaku.html");
    const facilities = parseFacilities(html);
    expect(facilities).toHaveLength(10);
    expect(facilities[0]).toEqual({ code: "116001", name: "豊島体育館" });
    expect(facilities).toContainEqual({ code: "116005", name: "総合体育場" });
  });
});

describe("parseDailyAvailability", () => {
  test("施設別空き状況から日別ステータスを抽出する", async () => {
    const html = await fixture("shisetsubetsu-aki.html");
    const entries = parseDailyAvailability(html);
    expect(entries).toContainEqual({
      roomCode: "00502",
      roomName: "庭球場",
      date: "2026-07-30",
      status: "△",
      checkdateValue: "2026073000502   0",
    });
    expect(entries).toContainEqual({
      roomCode: "00502",
      roomName: "庭球場",
      date: "2026-08-01",
      status: "×",
      checkdateValue: "2026080100502   0",
    });
  });

  test("休場日はエントリに含まれない", async () => {
    const html = await fixture("shisetsubetsu-aki.html");
    const entries = parseDailyAvailability(html);
    expect(entries.filter((e) => e.date === "2026-07-27")).toHaveLength(0);
  });
});

describe("parseTimeSlots", () => {
  test("時間帯別空き状況から空きコマを抽出する", async () => {
    const html = await fixture("jikantai-aki.html");
    const slots = parseTimeSlots(html);
    expect(slots).toHaveLength(5);
    expect(slots).toContainEqual({
      roomCode: "00502",
      date: "2026-07-30",
      courtNo: "02",
      timeRange: "11:00～13:00",
      checktimeValue: "00502202607300211:00～13:00",
    });
    expect(slots).toContainEqual({
      roomCode: "00502",
      date: "2026-07-30",
      courtNo: "03",
      timeRange: "9:00～11:00",
      checktimeValue: "0050220260730039:00～11:00",
    });
  });
});
