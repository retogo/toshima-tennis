import { describe, expect, test } from "bun:test";
import { loadCredentials } from "./credentials";

describe("loadCredentials", () => {
  test("環境変数から利用者番号とパスワードを読む", () => {
    expect(
      loadCredentials({ TOSHIMA_USER_ID: "1234567890", TOSHIMA_PASSWORD: "pw" }),
    ).toEqual({ userId: "1234567890", password: "pw" });
  });

  test("未設定なら設定すべき変数名を示して失敗する", () => {
    expect(() => loadCredentials({})).toThrow(/TOSHIMA_USER_ID/);
    expect(() => loadCredentials({ TOSHIMA_USER_ID: "x" })).toThrow(
      /TOSHIMA_PASSWORD/,
    );
  });

  test("空文字は未設定として扱う", () => {
    expect(() =>
      loadCredentials({ TOSHIMA_USER_ID: "  ", TOSHIMA_PASSWORD: "pw" }),
    ).toThrow(/TOSHIMA_USER_ID/);
  });

  test("サイトの上限 16 文字を超える値は送信前に弾く", () => {
    expect(() =>
      loadCredentials({
        TOSHIMA_USER_ID: "1".repeat(17),
        TOSHIMA_PASSWORD: "pw",
      }),
    ).toThrow(/16/);
  });

  test("エラーメッセージにパスワードそのものを含めない", () => {
    const secret = "s3cr3t-should-not-leak";
    try {
      loadCredentials({ TOSHIMA_USER_ID: "", TOSHIMA_PASSWORD: secret });
      throw new Error("失敗するはず");
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });
});
