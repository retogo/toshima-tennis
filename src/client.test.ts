import { describe, expect, test } from "bun:test";
import { ToshimaClient } from "./client";

const TOKEN_PAGE = (token: string) =>
  `<input name="__RequestVerificationToken" type="hidden" value="${token}" />`;

function stubFetch(responses: (() => Response)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return responses[calls.length - 1]!();
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe("ToshimaClient", () => {
  test("openStartPage: CookieCheck リダイレクトを追従し cookie とトークンを保持する", async () => {
    const { calls, fetchFn } = stubFetch([
      () =>
        new Response("", {
          status: 302,
          headers: {
            location:
              "https://www2.pf489.com/Toshima/WebR/Home/StartPage/?CookieCheck=true",
            "set-cookie":
              "ASP.NET_SessionId=abc123; path=/; secure; HttpOnly",
          },
        }),
      () => new Response(TOKEN_PAGE("TOKEN1"), { status: 200 }),
    ]);
    const client = new ToshimaClient({ fetchFn, delayMs: 0 });
    await client.openStartPage();

    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain("CookieCheck=true");
    const headers = calls[1]!.init.headers as Record<string, string>;
    expect(headers["Cookie"]).toBe("ASP.NET_SessionId=abc123");
    expect(client.token).toBe("TOKEN1");
  });

  test("postBack: トークンとイベントを form-encode で送信し、次のトークンに更新する", async () => {
    const { calls, fetchFn } = stubFetch([
      () =>
        new Response(TOKEN_PAGE("TOKEN1"), {
          status: 200,
          headers: {
            "set-cookie": "ASP.NET_SessionId=abc123; path=/; secure",
          },
        }),
      () => new Response(TOKEN_PAGE("TOKEN2"), { status: 200 }),
    ]);
    const client = new ToshimaClient({ fetchFn, delayMs: 0 });
    await client.get("https://example.test/StartPage/");
    await client.postBack("https://example.test/WgR_ModeSelect", "ssCategory", "20", [
      ["checkShisetsu", "116005"],
    ]);

    const post = calls[1]!;
    const body = String(post.init.body);
    const params = new URLSearchParams(body);
    expect(params.get("__RequestVerificationToken")).toBe("TOKEN1");
    expect(params.get("__EVENTTARGET")).toBe("ssCategory");
    expect(params.get("__EVENTARGUMENT")).toBe("20");
    expect(params.get("checkShisetsu")).toBe("116005");
    const headers = post.init.headers as Record<string, string>;
    expect(headers["Cookie"]).toBe("ASP.NET_SessionId=abc123");
    expect(headers["Referer"]).toBe("https://example.test/StartPage/");
    expect(client.token).toBe("TOKEN2");
  });

  test("cookie 値に = が含まれても切り捨てずに保持する", async () => {
    const { calls, fetchFn } = stubFetch([
      () =>
        new Response(TOKEN_PAGE("TOKEN1"), {
          status: 200,
          headers: {
            "set-cookie":
              "__RequestVerificationToken_L3Rvc2hpbWEvV2ViUg__=abc+def/ghi==; path=/; secure",
          },
        }),
      () => new Response(TOKEN_PAGE("TOKEN2"), { status: 200 }),
    ]);
    const client = new ToshimaClient({ fetchFn, delayMs: 0 });
    await client.get("https://example.test/StartPage/");
    await client.postBack("https://example.test/WgR_ModeSelect", "next");

    const headers = calls[1]!.init.headers as Record<string, string>;
    expect(headers["Cookie"]).toBe(
      "__RequestVerificationToken_L3Rvc2hpbWEvV2ViUg__=abc+def/ghi==",
    );
  });
});
