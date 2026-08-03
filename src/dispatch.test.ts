import { describe, expect, test } from "bun:test";
import { dispatchReserveCommands } from "./dispatch";
import { REPLY_ENDPOINT } from "./line";

const context = {
  jobTarget: {
    project: "toshima-tennis",
    region: "asia-northeast1",
    job: "toshima-reserve",
  },
  channelAccessToken: "CHANNEL_TOKEN",
};

interface Call {
  url: string;
  body: unknown;
}

/** run API と reply API を URL で切り分けて記録するスタブ。 */
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

const options = (fetchFn: typeof fetch) => ({
  fetchFn,
  getToken: async () => "ACCESS_TOKEN",
});

const isRunApi = (url: string) => url.includes("run.googleapis.com");
const isReply = (url: string) => url === REPLY_ENDPOINT;

const replyTexts = (calls: Call[]) =>
  calls
    .filter((c) => isReply(c.url))
    .map((c) => (c.body as { messages: { text: string }[] }).messages[0]!.text);

describe("dispatchReserveCommands", () => {
  test("コマごとに reserve Job を起動する", async () => {
    const { calls, fetchFn } = stubFetch();
    await dispatchReserveCommands(
      [{ slot: "2026-08-09 第2面 17:00～19:00", replyToken: "T" }],
      context,
      options(fetchFn),
    );

    const run = calls.filter((c) => isRunApi(c.url));
    expect(run).toHaveLength(1);
    expect(run[0]!.url).toContain("/jobs/toshima-reserve:run");
  });

  test("起動できたら replyToken に開始を伝える", async () => {
    const { calls, fetchFn } = stubFetch();
    await dispatchReserveCommands(
      [{ slot: "2026-08-09 第2面 17:00～19:00", replyToken: "T" }],
      context,
      options(fetchFn),
    );

    expect(replyTexts(calls)).toHaveLength(1);
    expect(replyTexts(calls)[0]).toContain("2026-08-09 第2面 17:00～19:00");
  });

  test("Job の起動を待ち切ってから応答する（200 を返した後に処理を残さない）", async () => {
    // cpu_idle = true の Cloud Run ではレスポンス後の処理に CPU が割り当てられない。
    // 呼び出しが完了順に並ぶことで、await し切っていることを確かめる。
    const { calls, fetchFn } = stubFetch();
    await dispatchReserveCommands(
      [{ slot: "コマ", replyToken: "T" }],
      context,
      options(fetchFn),
    );

    expect(calls.map((c) => (isRunApi(c.url) ? "run" : "reply"))).toEqual([
      "run",
      "reply",
    ]);
  });

  test("Job の起動が失敗しても例外にせず、失敗を応答で返す", async () => {
    // webhook は LINE に必ず 200 を返す必要がある。ここで throw させない。
    const { calls, fetchFn } = stubFetch((url) =>
      isRunApi(url) ? new Response('{"error":"denied"}', { status: 403 }) : new Response("{}"),
    );

    await dispatchReserveCommands(
      [{ slot: "コマ", replyToken: "T" }],
      context,
      options(fetchFn),
    );

    expect(replyTexts(calls)[0]).toContain("失敗");
    expect(replyTexts(calls)[0]).toContain("403");
  });

  test("応答の送信が失敗しても例外にしない", async () => {
    const { fetchFn } = stubFetch((url) =>
      isReply(url) ? new Response("bad token", { status: 401 }) : new Response("{}"),
    );

    expect(
      dispatchReserveCommands(
        [{ slot: "コマ", replyToken: "T" }],
        context,
        options(fetchFn),
      ),
    ).resolves.toBeUndefined();
  });

  test("replyToken が無ければ応答を送らない", async () => {
    const { calls, fetchFn } = stubFetch();
    await dispatchReserveCommands(
      [{ slot: "コマ", replyToken: "" }],
      context,
      options(fetchFn),
    );

    expect(calls.filter((c) => isRunApi(c.url))).toHaveLength(1);
    expect(replyTexts(calls)).toEqual([]);
  });

  test("1 件目が失敗しても残りのコマを起動する", async () => {
    let first = true;
    const { calls, fetchFn } = stubFetch((url) => {
      if (!isRunApi(url)) return new Response("{}");
      if (first) {
        first = false;
        return new Response("boom", { status: 500 });
      }
      return new Response("{}");
    });

    await dispatchReserveCommands(
      [
        { slot: "コマA", replyToken: "T1" },
        { slot: "コマB", replyToken: "T2" },
      ],
      context,
      options(fetchFn),
    );

    expect(calls.filter((c) => isRunApi(c.url))).toHaveLength(2);
    expect(replyTexts(calls)[0]).toContain("失敗");
    expect(replyTexts(calls)[1]).toContain("コマB");
  });

  test("応答本文にアクセストークンを含めない", async () => {
    const secret = "token-should-not-leak";
    const { calls, fetchFn } = stubFetch((url) =>
      isRunApi(url) ? new Response(`bad ${secret}`, { status: 500 }) : new Response("{}"),
    );

    await dispatchReserveCommands([{ slot: "コマ", replyToken: "T" }], context, {
      fetchFn,
      getToken: async () => secret,
    });

    expect(replyTexts(calls)[0]).not.toContain(secret);
  });

  test("コマンドが無ければ何もしない", async () => {
    const { calls, fetchFn } = stubFetch();
    await dispatchReserveCommands([], context, options(fetchFn));
    expect(calls).toEqual([]);
  });
});
