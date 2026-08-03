import { describe, expect, test } from "bun:test";
import { dispatchCommands } from "./dispatch";
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
};

const SLOT = "2026-08-24 第4面 9:00～11:00";

interface Call {
  url: string;
  body: unknown;
}

function stubFetch(
  responder: (url: string) => Response = () => new Response("{}"),
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

/** 承認の記録先。実際は GCS だが、テストではメモリに置く。 */
function stubStore(initial = "") {
  let value = initial;
  return {
    store: {
      async read() {
        return value;
      },
      async write(_key: string, next: string) {
        value = next;
      },
    },
    current: () => value,
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

  test("取消 Job には CANCEL_SLOT を渡す", async () => {
    const { calls, fetchFn } = stubFetch();
    const { store } = stubStore();
    await dispatchCommands(
      [{ action: "cancel", slot: SLOT, replyToken: "T" }],
      context,
      options(fetchFn, store),
    );

    const run = calls.find((c) => isRunApi(c.url))!;
    const env = (run.body as { overrides: { containerOverrides: { env: unknown[] }[] } })
      .overrides.containerOverrides[0]!.env;
    expect(env).toContainEqual({ name: "CANCEL_SLOT", value: SLOT });
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

    expect(replyTexts(calls)[0]).toContain("見つかりません");
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
