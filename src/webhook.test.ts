import { describe, expect, test } from "bun:test";
import { sign, verifySignature, extractReserveCommands } from "./webhook";

const SECRET = "channel-secret";
const ME = "Umyself0000000000000000000000000";
const STRANGER = "Ustranger00000000000000000000000";

function postbackEvent(userId: string, data: string) {
  return {
    type: "postback",
    replyToken: "rt-1",
    source: { type: "user", userId },
    postback: { data },
  };
}

describe("verifySignature", () => {
  test("正しい署名を受理する", async () => {
    const body = JSON.stringify({ events: [] });
    expect(await verifySignature(SECRET, body, await sign(SECRET, body))).toBe(
      true,
    );
  });

  test("本文が 1 文字でも違えば拒否する", async () => {
    const signature = await sign(SECRET, "{}");
    expect(await verifySignature(SECRET, "{} ", signature)).toBe(false);
  });

  test("別のシークレットで作られた署名は拒否する", async () => {
    const body = "{}";
    expect(await verifySignature(SECRET, body, await sign("other", body))).toBe(
      false,
    );
  });

  test("署名が無ければ拒否する", async () => {
    expect(await verifySignature(SECRET, "{}", null)).toBe(false);
    expect(await verifySignature(SECRET, "{}", "")).toBe(false);
  });

  test("base64 として壊れた署名でも例外にせず拒否する", async () => {
    expect(await verifySignature(SECRET, "{}", "!!!not-base64!!!")).toBe(false);
  });

  test("長さの違う署名でも例外にせず拒否する", async () => {
    expect(await verifySignature(SECRET, "{}", "YWJj")).toBe(false);
  });
});

describe("extractReserveCommands", () => {
  test("自分の postback から予約するコマを取り出す", () => {
    const body = {
      events: [postbackEvent(ME, "reserve:2026-08-08 第1面 9:00～11:00")],
    };
    expect(extractReserveCommands(body, ME)).toEqual([
      { slot: "2026-08-08 第1面 9:00～11:00", replyToken: "rt-1" },
    ]);
  });

  test("自分以外の userId は無視する（ボットは誰でも友だち追加できるため）", () => {
    const body = {
      events: [postbackEvent(STRANGER, "reserve:2026-08-08 第1面 9:00～11:00")],
    };
    expect(extractReserveCommands(body, ME)).toEqual([]);
  });

  test("userId が無いイベントは無視する", () => {
    const body = {
      events: [
        { type: "postback", replyToken: "rt", source: {}, postback: { data: "reserve:x" } },
      ],
    };
    expect(extractReserveCommands(body, ME)).toEqual([]);
  });

  test("postback 以外のイベントは無視する", () => {
    const body = {
      events: [
        { type: "message", replyToken: "rt", source: { userId: ME }, message: { type: "text", text: "reserve:x" } },
      ],
    };
    expect(extractReserveCommands(body, ME)).toEqual([]);
  });

  test("reserve: 以外の data は無視する", () => {
    const body = { events: [postbackEvent(ME, "cancel:2026-08-08")] };
    expect(extractReserveCommands(body, ME)).toEqual([]);
  });

  test("コマが空の data は無視する", () => {
    const body = { events: [postbackEvent(ME, "reserve:")] };
    expect(extractReserveCommands(body, ME)).toEqual([]);
  });

  test("events が無い/壊れていても例外にしない", () => {
    expect(extractReserveCommands({}, ME)).toEqual([]);
    expect(extractReserveCommands({ events: "x" }, ME)).toEqual([]);
    expect(extractReserveCommands(null, ME)).toEqual([]);
  });

  test("複数イベントのうち自分のものだけを返す", () => {
    const body = {
      events: [
        postbackEvent(STRANGER, "reserve:A"),
        postbackEvent(ME, "reserve:B"),
      ],
    };
    expect(extractReserveCommands(body, ME).map((c) => c.slot)).toEqual(["B"]);
  });
});
