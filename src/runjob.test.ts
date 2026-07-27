import { describe, expect, test } from "bun:test";
import { runReserveJob } from "./runjob";

function stubFetch(response: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  }) as typeof fetch;
  return { calls, fetchFn };
}

const target = {
  project: "toshima-tennis",
  region: "asia-northeast1",
  job: "toshima-tennis-reserve",
};

const options = (fetchFn: typeof fetch) => ({
  fetchFn,
  getToken: async () => "ACCESS_TOKEN",
});

describe("runReserveJob", () => {
  test("Cloud Run Jobs の run API を叩く", async () => {
    const { calls, fetchFn } = stubFetch(() => new Response("{}"));
    await runReserveJob(target, "2026-08-08 第1面 9:00～11:00", options(fetchFn));

    expect(calls[0]!.url).toBe(
      "https://run.googleapis.com/v2/projects/toshima-tennis/locations/asia-northeast1/jobs/toshima-tennis-reserve:run",
    );
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer ACCESS_TOKEN");
  });

  test("予約するコマを環境変数の上書きとして渡す", async () => {
    const { calls, fetchFn } = stubFetch(() => new Response("{}"));
    await runReserveJob(target, "2026-08-08 第1面 9:00～11:00", options(fetchFn));

    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.overrides.containerOverrides[0].env).toEqual([
      { name: "RESERVE_SLOT", value: "2026-08-08 第1面 9:00～11:00" },
    ]);
  });

  test("失敗したらステータスを含めて例外にする", async () => {
    const { fetchFn } = stubFetch(
      () => new Response('{"error":"denied"}', { status: 403 }),
    );
    await expect(
      runReserveJob(target, "コマ", options(fetchFn)),
    ).rejects.toThrow(/403/);
  });

  test("例外にアクセストークンを含めない", async () => {
    const secret = "token-should-not-leak";
    const { fetchFn } = stubFetch(
      () => new Response(`bad ${secret}`, { status: 500 }),
    );
    try {
      await runReserveJob(target, "コマ", {
        fetchFn,
        getToken: async () => secret,
      });
      throw new Error("失敗するはず");
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });
});
