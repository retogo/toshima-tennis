import { describe, expect, test } from "bun:test";
import { runJob } from "./runjob";

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

/** jobs.run が返す Operation。metadata は起動した Execution。 */
const operation = (execution = "toshima-tennis-reserve-ab12c") =>
  new Response(
    JSON.stringify({
      name: "projects/toshima-tennis/locations/asia-northeast1/operations/op-1",
      metadata: {
        name: `projects/toshima-tennis/locations/asia-northeast1/jobs/toshima-tennis-reserve/executions/${execution}`,
      },
    }),
  );

describe("runJob", () => {
  test("Cloud Run Jobs の run API を叩く", async () => {
    const { calls, fetchFn } = stubFetch(() => operation());
    await runJob(target, options(fetchFn));

    expect(calls[0]!.url).toBe(
      "https://run.googleapis.com/v2/projects/toshima-tennis/locations/asia-northeast1/jobs/toshima-tennis-reserve:run",
    );
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer ACCESS_TOKEN");
  });

  test("環境変数の上書きを渡さない", async () => {
    const { calls, fetchFn } = stubFetch(() => operation());
    await runJob(target, options(fetchFn));

    const body = JSON.parse(String(calls[0]!.init.body ?? "{}"));
    expect(body.overrides).toBeUndefined();
  });

  test("起動した Execution の名前を返す", async () => {
    const { fetchFn } = stubFetch(() => operation("toshima-tennis-reserve-xy9z8"));
    expect(await runJob(target, options(fetchFn))).toBe("toshima-tennis-reserve-xy9z8");
  });

  test("Execution の名前が無い応答は例外にする", async () => {
    const { fetchFn } = stubFetch(() => new Response("{}"));
    await expect(runJob(target, options(fetchFn))).rejects.toThrow(/Execution/);
  });

  test("失敗したらステータスを含めて例外にする", async () => {
    const { fetchFn } = stubFetch(
      () => new Response('{"error":"denied"}', { status: 403 }),
    );
    await expect(runJob(target, options(fetchFn))).rejects.toThrow(/403/);
  });

  test("例外にアクセストークンを含めない", async () => {
    const secret = "token-should-not-leak";
    const { fetchFn } = stubFetch(
      () => new Response(`bad ${secret}`, { status: 500 }),
    );
    try {
      await runJob(target, {
        fetchFn,
        getToken: async () => secret,
      });
      throw new Error("失敗するはず");
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });
});
