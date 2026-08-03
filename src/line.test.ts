import { describe, expect, test } from "bun:test";
import {
  TERMS,
  buildSettingsMessage,
  buildMenuMessage,
  buildReservedMessage,
  buildStatusMessage,
  pushMessage,
  buildCandidateMessage,
  MAX_BUTTONS,
  PUSH_ENDPOINT,
} from "./line";
import { MAX_PER_MONTH_CHOICES, TIME_RANGES } from "./settings";

function stubFetch(response: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  }) as typeof fetch;
  return { calls, fetchFn };
}

const ok = () => new Response("{}", { status: 200 });

describe("buildCandidateMessage", () => {
  test("候補ごとに予約ボタンを並べる", () => {
    const msg = buildCandidateMessage("見出し", [
      "2026-08-08 第1面 9:00～11:00",
      "2026-08-09 第2面 13:00～15:00",
    ]);
    const json = JSON.stringify(msg);
    expect(msg.type).toBe("flex");
    expect(json).toContain("2026-08-08 第1面 9:00～11:00");
    expect(json).toContain("2026-08-09 第2面 13:00～15:00");
  });

  test("ボタンは postback で reserve:<コマ> を送る", () => {
    const msg = buildCandidateMessage("見出し", ["2026-08-08 第1面 9:00～11:00"]);
    const json = JSON.stringify(msg);
    expect(json).toContain('"type":"postback"');
    expect(json).toContain("reserve:2026-08-08 第1面 9:00～11:00");
  });

  test("注記を末尾に添えられる", () => {
    const msg = buildCandidateMessage("見出し", ["2026-08-08 第1面 9:00～11:00"], {
      note: "ボタンを押すと予約が確定します",
    });
    expect(JSON.stringify(msg)).toContain("ボタンを押すと予約が確定します");
  });

  test("候補は 1 か所にだけ出す（本文とボタンで重複させない）", () => {
    const slot = "2026-08-08 第1面 9:00～11:00";
    const json = JSON.stringify(buildCandidateMessage("見出し", [slot]));
    const textOccurrences = (json.match(/2026-08-08 第1面 9:00～11:00/g) ?? [])
      .length;
    // 表示用テキスト 1 回 + postback data 1 回のみ
    expect(textOccurrences).toBe(2);
  });

  test("altText に見出しを使う（通知一覧に出るため）", () => {
    const msg = buildCandidateMessage("🎾 承認待ち", ["2026-08-08 第1面 9:00～11:00"]);
    expect(msg.altText).toContain("承認待ち");
  });

  test("ボタンのラベルは 20 文字以内（LINE の postback label 上限）", () => {
    const msg = buildCandidateMessage("見出し", [
      "2026-08-08 第1面 9:00～11:00",
    ]);
    const labels = [...JSON.stringify(msg).matchAll(/"label":"(.*?)"/g)].map(
      (m) => m[1]!,
    );
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(label.length).toBeLessThanOrEqual(20);
  });

  test("候補が多すぎる場合は先頭から MAX_BUTTONS 件までに絞る", () => {
    const many = Array.from({ length: 20 }, (_, i) => `2026-08-08 第${i + 1}面 9:00～11:00`);
    const json = JSON.stringify(buildCandidateMessage("見出し", many));
    const buttons = json.match(/"type":"postback"/g) ?? [];
    expect(buttons.length).toBe(MAX_BUTTONS);
  });
});

describe("pushMessage", () => {
  test("Messaging API の push エンドポイントにテキストを送る", async () => {
    const { calls, fetchFn } = stubFetch(ok);
    await pushMessage("TOKEN", "Uxxxx", "本文", fetchFn);

    const [call] = calls;
    expect(call!.url).toBe(PUSH_ENDPOINT);
    expect(call!.init.method).toBe("POST");
    const headers = call!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer TOKEN");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(call!.init.body))).toEqual({
      to: "Uxxxx",
      messages: [{ type: "text", text: "本文" }],
    });
  });

  test("失敗したらステータスを含めて例外にする", async () => {
    const { fetchFn } = stubFetch(
      () => new Response('{"message":"Invalid to"}', { status: 400 }),
    );
    await expect(pushMessage("TOKEN", "Uxxxx", "本文", fetchFn)).rejects.toThrow(
      /400/,
    );
  });

  test("無料枠超過（429）はそれと分かるメッセージにする", async () => {
    const { fetchFn } = stubFetch(
      () => new Response('{"message":"monthly limit exceeded"}', { status: 429 }),
    );
    await expect(pushMessage("TOKEN", "Uxxxx", "本文", fetchFn)).rejects.toThrow(
      /無料枠|上限/,
    );
  });

  test("例外にアクセストークンを含めない（Actions のログは公開されるため）", async () => {
    const secret = "channel-access-token-should-not-leak";
    const { fetchFn } = stubFetch(
      () => new Response(`{"message":"bad ${secret}"}`, { status: 400 }),
    );
    try {
      await pushMessage(secret, "Uxxxx", "本文", fetchFn);
      throw new Error("失敗するはず");
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });
});

describe("buildReservedMessage", () => {
  const SLOT = "2026-08-24 第4面 9:00～11:00";

  test("承認と取消のボタンを付ける", () => {
    const message = buildReservedMessage("見出し", [SLOT], "2026-08-15");
    const json = JSON.stringify(message);
    expect(json).toContain(`approve:${SLOT}`);
    expect(json).toContain(`cancel:${SLOT}`);
  });

  test("承認しなかった場合に取消される日を本文に出す", () => {
    const message = buildReservedMessage("見出し", [SLOT], "2026-08-15");
    expect(JSON.stringify(message)).toContain("2026-08-15");
  });

  test("コマ名を本文に出す（postback の label は 20 文字までのため）", () => {
    const message = buildReservedMessage("見出し", [SLOT], "2026-08-15");
    expect(JSON.stringify(message)).toContain(SLOT);
  });

  test("ボタンの label は 20 文字を超えない", () => {
    const json = JSON.stringify(buildReservedMessage("見出し", [SLOT], "2026-08-15"));
    for (const m of json.matchAll(/"label":"([^"]*)"/g)) {
      expect(m[1]!.length).toBeLessThanOrEqual(20);
    }
  });

  test("altText に見出しを使う", () => {
    expect(buildReservedMessage("見出し", [SLOT], "2026-08-15").altText).toBe("見出し");
  });
});

describe("buildMenuMessage", () => {
  test("押すと用語が送信される（何を操作したか会話に残る）", () => {
    const message = buildMenuMessage("approve");
    const json = JSON.stringify(message);
    expect(json).toContain('"type":"message"');
    expect(json).toContain(TERMS.status);
  });

  test("いまどちらのモードかを言葉で出す", () => {
    expect(JSON.stringify(buildMenuMessage("approve"))).toContain("押したら予約");
    expect(JSON.stringify(buildMenuMessage("auto"))).toContain("自動で予約");
  });

  test("切替ボタンはもう片方のモードだけを出す（選択中の装飾に頼らない）", () => {
    const onApprove = JSON.stringify(buildMenuMessage("approve"));
    expect(onApprove).toContain(TERMS.auto);
    expect(onApprove).not.toContain(TERMS.approve);

    const onAuto = JSON.stringify(buildMenuMessage("auto"));
    expect(onAuto).toContain(TERMS.approve);
  });

  test("吹き出しを最大幅にする（既定は狭くて折り返す）", () => {
    expect(JSON.stringify(buildMenuMessage("approve"))).toContain("giga");
  });

  test("ボタンの label は 20 文字を超えない", () => {
    const json = JSON.stringify(buildMenuMessage("auto"));
    for (const m of json.matchAll(/"label":"([^"]*)"/g)) {
      expect(m[1]!.length).toBeLessThanOrEqual(20);
    }
  });

  test("廃止した notify は出さない", () => {
    expect(JSON.stringify(buildMenuMessage("approve"))).not.toContain("notify");
  });
});

describe("buildStatusMessage", () => {
  const text = "■ 動作モード: auto\n\n■ 予約 1 件";

  test("本文をそのまま載せる", () => {
    expect(JSON.stringify(buildStatusMessage(text, []))).toContain("動作モード");
  });

  test("取消できる予約には取消ボタンを付ける", () => {
    const json = JSON.stringify(
      buildStatusMessage(text, [{ slot: "2026-08-24 第1面 9:00～11:00", cancellable: true }]),
    );
    expect(json).toContain("cancel:2026-08-24 第1面 9:00～11:00");
  });

  test("取消できない予約にはボタンを付けない", () => {
    const json = JSON.stringify(
      buildStatusMessage(text, [{ slot: "2026-08-09 第1面 15:00～17:00", cancellable: false }]),
    );
    expect(json).not.toContain("cancel:2026-08-09");
  });
});

describe("buildSettingsMessage", () => {
  const current = { maxPerMonth: 2, daysOfWeek: [0, 6], timeRanges: [] as string[] };

  test("いま選んでいる曜日を文字で出す（装飾に頼らない）", () => {
    const json = JSON.stringify(buildSettingsMessage(current));
    expect(json).toContain("日 土");
  });

  test("時間帯が空なら「指定なし」と出す", () => {
    expect(JSON.stringify(buildSettingsMessage(current))).toContain("指定なし");
  });

  test("選んでいる時間帯を文字で出す", () => {
    const json = JSON.stringify(
      buildSettingsMessage({ ...current, timeRanges: ["9:00～11:00"] }),
    );
    expect(json).toContain("9:00～11:00");
  });

  test("曜日は 7 つ、時間帯は 6 つのボタンを出す", () => {
    const json = JSON.stringify(buildSettingsMessage(current));
    for (let day = 0; day <= 6; day++) expect(json).toContain(`day:${day}`);
    for (const range of TIME_RANGES) expect(json).toContain(`time:${range}`);
  });

  test("月の上限は選べる値のボタンを出す", () => {
    const json = JSON.stringify(buildSettingsMessage(current));
    for (const n of MAX_PER_MONTH_CHOICES) expect(json).toContain(`max:${n}`);
  });

  test("いまの月の上限と支出の目安を出す", () => {
    const json = JSON.stringify(buildSettingsMessage(current));
    expect(json).toContain("2 件");
    expect(json).toContain("4,000");
  });

  test("曜日が空なら何も予約しないと分かるように出す", () => {
    const json = JSON.stringify(buildSettingsMessage({ ...current, daysOfWeek: [] }));
    expect(json).toContain("予約しません");
  });

  test("ボタンの label は 20 文字を超えない", () => {
    const json = JSON.stringify(buildSettingsMessage(current));
    for (const m of json.matchAll(/"label":"([^"]*)"/g)) {
      expect(m[1]!.length).toBeLessThanOrEqual(20);
    }
  });
});
