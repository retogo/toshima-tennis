import { describe, expect, test } from "bun:test";
import { dispatchCommands } from "./dispatch";
import { jobRequestKey } from "./jobrequest";
import { REPLY_ENDPOINT } from "./line";
import { serializeTracked, trackReservation } from "./tracked";

const context = {
  jobTarget: {
    project: "toshima-tennis",
    region: "asia-northeast1",
    job: "toshima-reserve",
  },
  cancelJob: "toshima-cancel",
  channelAccessToken: "CHANNEL_TOKEN",
  defaultMode: "approve" as const,
  defaultWishes: { maxPerMonth: 2, daysOfWeek: [0, 6], timeRanges: [] as string[] },
};

const SLOT = "2026-08-24 第4面 9:00～11:00";

interface Call {
  url: string;
  body: unknown;
}

/** jobs.run が返す Operation。Execution 名は Job 名から決め打ちにする。 */
function runResponse(url: string): Response {
  const job = url.match(/jobs\/([^:]+):run/)![1];
  return new Response(
    JSON.stringify({ metadata: { name: `projects/p/locations/l/jobs/${job}/executions/${job}-exec1` } }),
  );
}

function stubFetch(
  responder: (url: string) => Response = (url) =>
    url.includes("run.googleapis.com") ? runResponse(url) : new Response("{}"),
) {
  const calls: Call[] = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    calls.push({
      url: target,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return responder(target);
  }) as typeof fetch;
  return { calls, fetchFn };
}

/** 状態の置き場。実際は GCS だが、テストではメモリに置く。 */
function stubStore(initialTracked = "") {
  const files = new Map<string, string>();
  if (initialTracked) files.set("tracked.json", initialTracked);
  return {
    store: {
      async read(key: string) {
        return files.get(key) ?? "";
      },
      async write(key: string, next: string) {
        files.set(key, next);
      },
    },
    current: (key = "tracked.json") => files.get(key) ?? "",
  };
}

const isRunApi = (url: string) => url.includes("run.googleapis.com");
const isReply = (url: string) => url === REPLY_ENDPOINT;

const jobNames = (calls: Call[]) =>
  calls.filter((c) => isRunApi(c.url)).map((c) => c.url.match(/jobs\/([^:]+):run/)![1]);

const replyTexts = (calls: Call[]) =>
  calls
    .filter((c) => isReply(c.url))
    .map((c) => (c.body as { messages: { text: string }[] }).messages[0]!.text);

const options = (fetchFn: typeof fetch, store: unknown) => ({
  fetchFn,
  getToken: async () => "ACCESS_TOKEN",
  state: store as never,
});

describe("dispatchCommands: 予約", () => {
  test("reserve は予約 Job を起動する", async () => {
    const { calls, fetchFn } = stubFetch();
    const { store } = stubStore();
    await dispatchCommands(
      [{ action: "reserve", slot: SLOT, replyToken: "T" }],
      context,
      options(fetchFn, store),
    );

    expect(jobNames(calls)).toEqual(["toshima-reserve"]);
    expect(replyTexts(calls)[0]).toContain(SLOT);
  });

  test("予約するコマは起動した Execution の依頼として書き、上書きは渡さない", async () => {
    const { calls, fetchFn } = stubFetch();
    const { store, current } = stubStore();
    await dispatchCommands(
      [{ action: "reserve", slot: SLOT, replyToken: "T" }],
      context,
      options(fetchFn, store),
    );

    const run = calls.find((c) => isRunApi(c.url))!;
    expect(run.body).toBeUndefined();
    expect(JSON.parse(current(jobRequestKey("toshima-reserve-exec1")))).toEqual({ slot: SLOT });
  });
});

describe("dispatchCommands: 取消", () => {
  test("cancel は取消 Job を起動する", async () => {
    const { calls, fetchFn } = stubFetch();
    const { store } = stubStore();
    await dispatchCommands(
      [{ action: "cancel", slot: SLOT, replyToken: "T" }],
      context,
      options(fetchFn, store),
    );

    expect(jobNames(calls)).toEqual(["toshima-cancel"]);
  });

  test("取り消すコマは起動した Execution の依頼として書き、上書きは渡さない", async () => {
    const { calls, fetchFn } = stubFetch();
    const { store, current } = stubStore();
    await dispatchCommands(
      [{ action: "cancel", slot: SLOT, replyToken: "T" }],
      context,
      options(fetchFn, store),
    );

    const run = calls.find((c) => isRunApi(c.url))!;
    expect(run.body).toBeUndefined();
    expect(JSON.parse(current(jobRequestKey("toshima-cancel-exec1")))).toEqual({ slot: SLOT });
  });
});

describe("dispatchCommands: 承認", () => {
  test("approve は Job を起動せず、記録を承認済みにする", async () => {
    const { calls, fetchFn } = stubFetch();
    const { store, current } = stubStore(
      serializeTracked(trackReservation({}, SLOT, "2026-08-03")),
    );

    await dispatchCommands(
      [{ action: "approve", slot: SLOT, replyToken: "T" }],
      context,
      options(fetchFn, store),
    );

    expect(jobNames(calls)).toEqual([]);
    expect(JSON.parse(current())["2026-08-24 9:00～11:00"].approved).toBe(true);
  });

  test("承認したことを応答で伝える", async () => {
    const { calls, fetchFn } = stubFetch();
    const { store } = stubStore(
      serializeTracked(trackReservation({}, SLOT, "2026-08-03")),
    );

    await dispatchCommands(
      [{ action: "approve", slot: SLOT, replyToken: "T" }],
      context,
      options(fetchFn, store),
    );

    expect(replyTexts(calls)[0]).toContain("承認");
  });

  test("記録に無いコマの承認は、そう伝える", async () => {
    const { calls, fetchFn } = stubFetch();
    const { store } = stubStore();

    await dispatchCommands(
      [{ action: "approve", slot: SLOT, replyToken: "T" }],
      context,
      options(fetchFn, store),
    );

    expect(replyTexts(calls)[0]).toContain("手動の予約");
  });
});

describe("dispatchCommands: 失敗の扱い", () => {
  test("Job の起動に失敗しても例外にせず応答で伝える", async () => {
    const { calls, fetchFn } = stubFetch((url) =>
      isRunApi(url) ? new Response('{"error":"denied"}', { status: 403 }) : new Response("{}"),
    );
    const { store } = stubStore();

    await dispatchCommands(
      [{ action: "cancel", slot: SLOT, replyToken: "T" }],
      context,
      options(fetchFn, store),
    );

    expect(replyTexts(calls)[0]).toContain("403");
  });

  test("承認の記録に失敗しても例外にしない（LINE には 200 を返す）", async () => {
    const { fetchFn } = stubFetch();
    const failing = {
      async read() {
        return serializeTracked(trackReservation({}, SLOT, "2026-08-03"));
      },
      async write() {
        throw new Error("GCS 書き込み失敗");
      },
    };

    expect(
      dispatchCommands(
        [{ action: "approve", slot: SLOT, replyToken: "T" }],
        context,
        options(fetchFn, failing),
      ),
    ).resolves.toBeUndefined();
  });

  test("replyToken が無ければ応答を送らない", async () => {
    const { calls, fetchFn } = stubFetch();
    const { store } = stubStore();
    await dispatchCommands(
      [{ action: "cancel", slot: SLOT, replyToken: "" }],
      context,
      options(fetchFn, store),
    );

    expect(replyTexts(calls)).toEqual([]);
  });

  test("複数の指示をすべて処理する", async () => {
    const { calls, fetchFn } = stubFetch();
    const { store } = stubStore();
    await dispatchCommands(
      [
        { action: "reserve", slot: SLOT, replyToken: "T1" },
        { action: "cancel", slot: "2026-08-25 第1面 13:00～15:00", replyToken: "T2" },
      ],
      context,
      options(fetchFn, store),
    );

    expect(jobNames(calls)).toEqual(["toshima-reserve", "toshima-cancel"]);
  });

  test("指示が無ければ何もしない", async () => {
    const { calls, fetchFn } = stubFetch();
    const { store } = stubStore();
    await dispatchCommands([], context, options(fetchFn, store));
    expect(calls).toEqual([]);
  });
});

describe("dispatchCommands: メニュー・状況・モード", () => {
  const replyFlex = (calls: Call[]) =>
    calls
      .filter((c) => isReply(c.url))
      .map((c) => JSON.stringify((c.body as { messages: unknown[] }).messages));

  test("menu は Job を起動せず、応答でメニューを返す", async () => {
    const { calls, fetchFn } = stubFetch();
    const { store } = stubStore();
    await dispatchCommands(
      [{ action: "menu", slot: "", replyToken: "T" }],
      context,
      options(fetchFn, store),
    );

    expect(jobNames(calls)).toEqual([]);
    expect(replyFlex(calls)[0]).toContain("状況");
  });

  test("メニューには保存されている現在のモードを出す", async () => {
    const { calls, fetchFn } = stubFetch();
    const { store } = stubStore();
    await store.write("settings.json", JSON.stringify({ mode: "auto" }));
    await dispatchCommands(
      [{ action: "menu", slot: "", replyToken: "T" }],
      context,
      options(fetchFn, store),
    );

    expect(replyFlex(calls)[0]).toContain("自動で予約");
  });

  test("mode は保存するだけで Job を起動しない", async () => {
    const { calls, fetchFn } = stubFetch();
    const { store, current } = stubStore();
    await dispatchCommands(
      [{ action: "mode", slot: "auto", replyToken: "T" }],
      context,
      options(fetchFn, store),
    );

    expect(jobNames(calls)).toEqual([]);
    expect(JSON.parse(current("settings.json")).mode).toBe("auto");
  });

  test("auto に切り替えたら費用が動くことを応答で伝える", async () => {
    const { calls, fetchFn } = stubFetch();
    const { store } = stubStore();
    await dispatchCommands(
      [{ action: "mode", slot: "auto", replyToken: "T" }],
      context,
      options(fetchFn, store),
    );

    expect(replyFlex(calls)[0]).toContain("自動で予約");
  });

  test("知らないモードは保存しない", async () => {
    const { calls, fetchFn } = stubFetch();
    const { store, current } = stubStore();
    await dispatchCommands(
      [{ action: "mode", slot: "garbage", replyToken: "T" }],
      context,
      options(fetchFn, store),
    );

    expect(current("settings.json")).toBe("");
    expect(replyFlex(calls)[0]).toContain("不明なモード");
  });

  test("status はスナップショットから応答を作る（Job を起動しない）", async () => {
    const { calls, fetchFn } = stubFetch();
    const { store } = stubStore();
    await store.write(
      "reservations.json",
      JSON.stringify({
        takenAt: "2026-08-03T09:00:00.000Z",
        reservations: [
          { date: "2026-08-24", timeRange: "9:00～11:00", feeYen: 2000, status: "本予約", cancelValue: "1" },
        ],
      }),
    );

    await dispatchCommands(
      [{ action: "status", slot: "", replyToken: "T" }],
      context,
      options(fetchFn, store),
    );

    expect(jobNames(calls)).toEqual([]);
    const reply = replyFlex(calls)[0]!;
    expect(reply).toContain("2026-08-24");
    expect(reply).toContain("2026-08-17"); // 取消期限
  });

  test("スナップショットが無ければ、まだ取得できていないと伝える", async () => {
    const { calls, fetchFn } = stubFetch();
    const { store } = stubStore();
    await dispatchCommands(
      [{ action: "status", slot: "", replyToken: "T" }],
      context,
      options(fetchFn, store),
    );

    expect(replyFlex(calls)[0]).toContain("取得できていません");
  });
});
