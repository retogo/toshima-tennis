import { describe, expect, test } from "bun:test";
import { MOKUTEKI, ToshimaClient } from "./client";

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

  describe("selectFacility", () => {
    const FACILITY_PAGE =
      TOKEN_PAGE("TOKEN2") +
      '<input name="textDate" value="2026/7/27" />' +
      '<input type="radio" name="radioPeriod" value="2週間" checked/>';

    async function selecting(pages: string[]) {
      const { calls, fetchFn } = stubFetch([
        () => new Response(TOKEN_PAGE("TOKEN1"), { status: 200 }),
        ...pages.map((p) => () => new Response(p, { status: 200 })),
      ]);
      const client = new ToshimaClient({ fetchFn, delayMs: 0 });
      await client.get("https://example.test/StartPage/");
      await client.selectFacility("116005");
      return calls;
    }

    test("施設を選んだあと hyouji で表示期間を 1ヶ月にする", async () => {
      // 既定の 2 週間だと土日が 4 日しか入らず、予約可能な土日を取りこぼす
      const calls = await selecting([FACILITY_PAGE, TOKEN_PAGE("TOKEN3")]);

      const select = new URLSearchParams(String(calls[1]!.init.body));
      expect(select.get("__EVENTTARGET")).toBe("next");
      expect(select.get("checkShisetsu")).toBe("116005");

      const period = new URLSearchParams(String(calls[2]!.init.body));
      expect(calls[2]!.url).toContain("WgR_ShisetsubetsuAkiJoukyou");
      expect(period.get("__EVENTTARGET")).toBe("hyouji");
      expect(period.get("radioPeriod")).toBe("1ヶ月");
    });

    test("textDate は画面の値をそのまま使う（実行環境の日付に依存させない）", async () => {
      // Cloud Run は UTC で動くため、自前で「今日」を組み立てると JST とずれる
      const calls = await selecting([FACILITY_PAGE, TOKEN_PAGE("TOKEN3")]);
      const period = new URLSearchParams(String(calls[2]!.init.body));
      expect(period.get("textDate")).toBe("2026/7/27");
    });
  });

  describe("login", () => {
    const LOGIN_FORM =
      TOKEN_PAGE("TOKEN2") +
      '<input type="text" name="txtUserID" id="userID" maxlength="16" />' +
      '<input type="password" name="txtPassWord" id="passWord" maxlength="16" />';

    async function loggedInClient(second: () => Response) {
      const { calls, fetchFn } = stubFetch([
        () => new Response(TOKEN_PAGE("TOKEN1"), { status: 200 }),
        second,
      ]);
      const client = new ToshimaClient({ fetchFn, delayMs: 0 });
      await client.get("https://example.test/Home/WgR_Login");
      return { calls, client };
    }

    test("nextlogin として利用者番号とパスワードを送る", async () => {
      const { calls, client } = await loggedInClient(
        () => new Response(TOKEN_PAGE("TOKEN2") + "予約内容の確認", { status: 200 }),
      );
      await client.login("1234567890", "pw");

      const params = new URLSearchParams(String(calls[1]!.init.body));
      expect(params.get("__EVENTTARGET")).toBe("nextlogin");
      expect(params.get("txtUserID")).toBe("1234567890");
      expect(params.get("txtPassWord")).toBe("pw");
      expect(params.get("__RequestVerificationToken")).toBe("TOKEN1");
      expect(calls[1]!.url).toContain("/Home/WgR_Login");
    });

    test("ログイン画面が返ってきたら失敗として扱う", async () => {
      const { client } = await loggedInClient(
        () => new Response(LOGIN_FORM, { status: 200 }),
      );
      await expect(client.login("1234567890", "wrong")).rejects.toThrow(
        /ログインに失敗/,
      );
    });

    test("失敗時の例外にパスワードを含めない", async () => {
      const { client } = await loggedInClient(
        () => new Response(LOGIN_FORM, { status: 200 }),
      );
      await expect(client.login("1234567890", "s3cr3t")).rejects.toThrow(
        expect.not.stringContaining("s3cr3t") as unknown as string,
      );
    });
  });

  describe("submitApplication", () => {
    const APPLICATION_FORM =
      TOKEN_PAGE("TOKEN2") +
      '<input type="number" name="spinnerNinzu" />' +
      '<input type="radio" name="radioMokuteki" value="404" />' +
      '<input type="text" name="txtYykShousai" />';

    async function atApplicationScreen(second: () => Response) {
      const { calls, fetchFn } = stubFetch([
        () => new Response(TOKEN_PAGE("TOKEN1"), { status: 200 }),
        second,
      ]);
      const client = new ToshimaClient({ fetchFn, delayMs: 0 });
      await client.get("https://example.test/Yoyaku/WgR_ShousaiShinsei");
      return { calls, client };
    }

    test("next として利用人数・使用目的・行事名称を送る", async () => {
      const { calls, client } = await atApplicationScreen(
        () => new Response(TOKEN_PAGE("TOKEN2") + "申込確認", { status: 200 }),
      );
      await client.submitApplication({
        ninzu: 4,
        mokuteki: MOKUTEKI.tennis,
        gyoujiMeishou: "テニス練習",
      });

      const post = calls[1]!;
      expect(post.url).toContain("/Yoyaku/WgR_ShousaiShinsei");
      const params = new URLSearchParams(String(post.init.body));
      expect(params.get("__EVENTTARGET")).toBe("next");
      expect(params.get("spinnerNinzu")).toBe("4");
      expect(params.get("radioMokuteki")).toBe("404");
      expect(params.get("txtYykShousai")).toBe("テニス練習");
    });

    test("使用目的コードはテニスとソフトテニスを区別する", () => {
      expect(MOKUTEKI.tennis).toBe("404");
      expect(MOKUTEKI.softTennis).toBe("405");
    });

    test("詳細申請画面が返ってきたら進めなかったものとして失敗させる", async () => {
      const { client } = await atApplicationScreen(
        () => new Response(APPLICATION_FORM, { status: 200 }),
      );
      await expect(
        client.submitApplication({
          ninzu: 4,
          mokuteki: MOKUTEKI.tennis,
          gyoujiMeishou: "テニス練習",
        }),
      ).rejects.toThrow(/詳細申請/);
    });
  });

  describe("confirmReservation", () => {
    const CONFIRM_SCREEN =
      TOKEN_PAGE("TOKEN2") +
      "<input type=\"button\" value=\" 申込\" onclick=\"javascript:__doPostBack('next','')\" />";

    async function atConfirmScreen(second: () => Response) {
      const { calls, fetchFn } = stubFetch([
        () => new Response(TOKEN_PAGE("TOKEN1"), { status: 200 }),
        second,
      ]);
      const client = new ToshimaClient({ fetchFn, delayMs: 0 });
      await client.get("https://example.test/Yoyaku/WgR_YoyakuKakunin");
      return { calls, client };
    }

    test("申込確認画面に next を送って確定する", async () => {
      const { calls, client } = await atConfirmScreen(
        () => new Response(TOKEN_PAGE("TOKEN2") + "申込完了", { status: 200 }),
      );
      await client.confirmReservation();

      const post = calls[1]!;
      expect(post.url).toContain("/Yoyaku/WgR_YoyakuKakunin");
      const params = new URLSearchParams(String(post.init.body));
      expect(params.get("__EVENTTARGET")).toBe("next");
    });

    test("確定後も申込確認画面が返ってきたら失敗として扱う", async () => {
      const { client } = await atConfirmScreen(
        () => new Response(CONFIRM_SCREEN, { status: 200 }),
      );
      await expect(client.confirmReservation()).rejects.toThrow(/申込/);
    });
  });
});
