import { describe, expect, test } from "bun:test";
import {
  sign,
  verifySignature,
  extractCommands,
  extractReserveCommands,
} from "./webhook";

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

describe("extractCommands", () => {
  test("reserve / approve / cancel を種類つきで取り出す", () => {
    const body = {
      events: [
        postbackEvent(ME, "reserve:2026-08-24 第4面 9:00～11:00"),
        postbackEvent(ME, "approve:2026-08-24 第4面 9:00～11:00"),
        postbackEvent(ME, "cancel:2026-08-24 第4面 9:00～11:00"),
      ],
    };
    expect(extractCommands(body, ME).map((c) => c.action)).toEqual([
      "reserve",
      "approve",
      "cancel",
    ]);
  });

  test("コマ名を取り出す", () => {
    const body = { events: [postbackEvent(ME, "cancel:2026-08-24 第4面 9:00～11:00")] };
    expect(extractCommands(body, ME)[0]!.slot).toBe("2026-08-24 第4面 9:00～11:00");
  });

  test("他人からの取消指示は捨てる（第三者に予約を消させない）", () => {
    const body = { events: [postbackEvent(STRANGER, "cancel:2026-08-24 第4面 9:00～11:00")] };
    expect(extractCommands(body, ME)).toEqual([]);
  });

  test("知らない種類は捨てる", () => {
    const body = { events: [postbackEvent(ME, "delete:2026-08-24 第4面 9:00～11:00")] };
    expect(extractCommands(body, ME)).toEqual([]);
  });

  test("コマが空なら捨てる", () => {
    const body = { events: [postbackEvent(ME, "cancel:")] };
    expect(extractCommands(body, ME)).toEqual([]);
  });

  test("events が壊れていても例外にしない", () => {
    expect(extractCommands(null, ME)).toEqual([]);
    expect(extractCommands({ events: "x" }, ME)).toEqual([]);
  });

  test("replyToken を持ち回る", () => {
    const body = { events: [postbackEvent(ME, "approve:2026-08-24 第4面 9:00～11:00")] };
    expect(extractCommands(body, ME)[0]!.replyToken).toBe("rt-1");
  });
});

function textEvent(userId: string, text: string) {
  return {
    type: "message",
    replyToken: "rt-1",
    source: { type: "user", userId },
    message: { type: "text", text },
  };
}

describe("extractCommands: メニューと状況", () => {
  test("status / mode を取り出す", () => {
    const body = {
      events: [postbackEvent(ME, "status:"), postbackEvent(ME, "mode:auto")],
    };
    expect(extractCommands(body, ME).map((c) => c.action)).toEqual([
      "status",
      "mode",
    ]);
  });

  test("status は対象コマを要求しない", () => {
    const body = { events: [postbackEvent(ME, "status:")] };
    expect(extractCommands(body, ME)[0]!.slot).toBe("");
  });

  test("予約や取消はコマが空なら無視する（menu / status とは違う）", () => {
    const body = {
      events: [postbackEvent(ME, "reserve:"), postbackEvent(ME, "cancel:")],
    };
    expect(extractCommands(body, ME)).toEqual([]);
  });
});

describe("extractCommands: テキストの用語", () => {
  test("「メニュー」でメニューを出す", () => {
    expect(extractCommands({ events: [textEvent(ME, "メニュー")] }, ME)).toEqual([
      { action: "menu", slot: "", replyToken: "rt-1" },
    ]);
  });

  test("「状況」で予約状況を出す", () => {
    expect(
      extractCommands({ events: [textEvent(ME, "状況")] }, ME).map((c) => c.action),
    ).toEqual(["status"]);
  });

  test("「自動」「手動」でモードを切り替える", () => {
    const auto = extractCommands({ events: [textEvent(ME, "自動")] }, ME)[0]!;
    expect(auto.action).toBe("mode");
    expect(auto.slot).toBe("auto");

    const manual = extractCommands({ events: [textEvent(ME, "手動")] }, ME)[0]!;
    expect(manual.action).toBe("mode");
    expect(manual.slot).toBe("approve");
  });

  test("前後の空白を無視する", () => {
    expect(
      extractCommands({ events: [textEvent(ME, " 状況 ")] }, ME).map((c) => c.action),
    ).toEqual(["status"]);
  });

  test("知らないテキストには反応しない", () => {
    // 用語だけに反応する。関係ない発言でメニューが出てこないように
    expect(extractCommands({ events: [textEvent(ME, "こんにちは")] }, ME)).toEqual([]);
    expect(extractCommands({ events: [textEvent(ME, "")] }, ME)).toEqual([]);
  });

  test("テキストで予約や取消はできない（誤送信で不可逆な操作を走らせない）", () => {
    expect(extractCommands({ events: [textEvent(ME, "cancel:x")] }, ME)).toEqual([]);
    expect(
      extractCommands({ events: [textEvent(ME, "2026-08-24 第1面 9:00～11:00")] }, ME),
    ).toEqual([]);
  });

  test("他人のテキストは無視する", () => {
    expect(extractCommands({ events: [textEvent(STRANGER, "状況")] }, ME)).toEqual([]);
  });

  test("テキスト以外のメッセージは無視する", () => {
    const body = {
      events: [
        {
          type: "message",
          replyToken: "rt-1",
          source: { type: "user", userId: ME },
          message: { type: "sticker", stickerId: "1" },
        },
      ],
    };
    expect(extractCommands(body, ME)).toEqual([]);
  });
});
