import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GcsStateStore, LocalStateStore } from "./state";

describe("LocalStateStore", () => {
  test("書いた値を読み戻せる", async () => {
    const store = new LocalStateStore(mkdtempSync(join(tmpdir(), "state-")));
    await store.write("last.txt", "abc");
    expect(await store.read("last.txt")).toBe("abc");
  });

  test("存在しないキーは空文字列", async () => {
    const store = new LocalStateStore(mkdtempSync(join(tmpdir(), "state-")));
    expect(await store.read("missing.txt")).toBe("");
  });

  test("ディレクトリが無ければ作る", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "state-")), "nested", "deep");
    const store = new LocalStateStore(dir);
    await store.write("a.txt", "v");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("v");
  });
});

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url), init ?? {});
  }) as typeof fetch;
  return { calls, fetchFn };
}

const gcsOptions = (fetchFn: typeof fetch) => ({
  fetchFn,
  getToken: async () => "ACCESS_TOKEN",
});

describe("GcsStateStore", () => {
  test("オブジェクトを alt=media で取得する", async () => {
    const { calls, fetchFn } = stubFetch(() => new Response("stored"));
    const store = new GcsStateStore("my-bucket", gcsOptions(fetchFn));

    expect(await store.read("last.txt")).toBe("stored");
    expect(calls[0]!.url).toBe(
      "https://storage.googleapis.com/storage/v1/b/my-bucket/o/last.txt?alt=media",
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer ACCESS_TOKEN");
  });

  test("404 は空文字列として扱う（初回実行）", async () => {
    const { fetchFn } = stubFetch(() => new Response("", { status: 404 }));
    const store = new GcsStateStore("my-bucket", gcsOptions(fetchFn));
    expect(await store.read("last.txt")).toBe("");
  });

  test("404 以外の失敗は例外にする", async () => {
    const { fetchFn } = stubFetch(() => new Response("boom", { status: 500 }));
    const store = new GcsStateStore("my-bucket", gcsOptions(fetchFn));
    await expect(store.read("last.txt")).rejects.toThrow(/500/);
  });

  test("アップロードは uploadType=media で name を指定する", async () => {
    const { calls, fetchFn } = stubFetch(() => new Response("{}"));
    const store = new GcsStateStore("my-bucket", gcsOptions(fetchFn));

    await store.write("reserved.txt", "a\nb");
    expect(calls[0]!.url).toBe(
      "https://storage.googleapis.com/upload/storage/v1/b/my-bucket/o?uploadType=media&name=reserved.txt",
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(String(calls[0]!.init.body)).toBe("a\nb");
  });

  test("アップロード失敗は例外にする", async () => {
    const { fetchFn } = stubFetch(() => new Response("nope", { status: 403 }));
    const store = new GcsStateStore("my-bucket", gcsOptions(fetchFn));
    await expect(store.write("a.txt", "v")).rejects.toThrow(/403/);
  });

  test("キーに含まれる記号を URL エンコードする", async () => {
    const { calls, fetchFn } = stubFetch(() => new Response("x"));
    const store = new GcsStateStore("my-bucket", gcsOptions(fetchFn));
    await store.read("dir/sub key.txt");
    expect(calls[0]!.url).toContain("dir%2Fsub%20key.txt");
  });

  test("例外にアクセストークンを含めない", async () => {
    const secret = "token-should-not-leak";
    const { fetchFn } = stubFetch(
      () => new Response(`bad ${secret}`, { status: 500 }),
    );
    const store = new GcsStateStore("my-bucket", {
      fetchFn,
      getToken: async () => secret,
    });
    try {
      await store.read("a.txt");
      throw new Error("失敗するはず");
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });
});
