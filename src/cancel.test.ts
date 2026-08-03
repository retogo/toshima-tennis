import { describe, expect, test } from "bun:test";
import { cancelReservation } from "./cancel";

const listHtml = await Bun.file("fixtures/yoyaku-list.html").text();
const cancelHtml = await Bun.file("fixtures/cancel-confirm.html").text();

/** 取消後の一覧（8/24 が消えた状態）を作る。 */
const listAfterCancel = listHtml.replace(/2026\/8\/24\(月\)/g, "2026/9/28(月)");

interface Recorded {
  step: string;
  cancelValue?: string;
}

/**
 * ToshimaClient の取消に使う部分だけを差し替えたスタブ。
 * 実サイトには一切アクセスしない。
 */
function stubClient(options: { listAfter?: string; confirmScreen?: string } = {}) {
  const steps: Recorded[] = [];
  const client = {
    async loginFromTop() {
      steps.push({ step: "login" });
      return "<form action='/toshima/WebR/Home/WgR_ModeSelect'></form>";
    },
    async openReservations() {
      steps.push({ step: "openReservations" });
      return steps.filter((s) => s.step === "openReservations").length === 1
        ? listHtml
        : (options.listAfter ?? listAfterCancel);
    },
    async selectForCancellation(_html: string, cancelValue: string) {
      steps.push({ step: "selectForCancellation", cancelValue });
      return options.confirmScreen ?? cancelHtml;
    },
    async confirmCancellation() {
      steps.push({ step: "confirmCancellation" });
      return "<div>予約取消完了</div>";
    },
    async openMenu() {
      steps.push({ step: "openMenu" });
      return "<form action='/toshima/WebR/Home/WgR_ModeSelect'></form>";
    },
  };
  return { steps, client: client as never };
}

const credentials = { userId: "U", password: "P" };
const TARGET = "2026-08-24 第4面 9:00～11:00";

describe("cancelReservation", () => {
  test("取消対象を選び、照合してから確定する", async () => {
    const { steps, client } = stubClient();
    await cancelReservation(client, TARGET, credentials);

    expect(steps.map((s) => s.step)).toEqual([
      "login",
      "openReservations",
      "selectForCancellation",
      "confirmCancellation",
      "openMenu",
      "openReservations",
    ]);
  });

  test("予約一覧から読んだ checkCancel の値を渡す", async () => {
    const { steps, client } = stubClient();
    await cancelReservation(client, TARGET, credentials);

    const select = steps.find((s) => s.step === "selectForCancellation");
    expect(select?.cancelValue).toBe("1");
  });

  test("dryRun では確定を送らない", async () => {
    const { steps, client } = stubClient();
    await cancelReservation(client, TARGET, credentials, { dryRun: true });

    expect(steps.map((s) => s.step)).not.toContain("confirmCancellation");
  });

  test("該当する予約が無ければ何もしない", async () => {
    const { steps, client } = stubClient();
    const result = await cancelReservation(
      client,
      "2026-12-25 第1面 9:00～11:00",
      credentials,
    );

    expect(result.outcome).toBe("not-found");
    expect(steps.map((s) => s.step)).not.toContain("confirmCancellation");
  });

  test("取消期限を過ぎた予約は取消せない（サイトが取消ボタンを出さない）", async () => {
    const { steps, client } = stubClient();
    const result = await cancelReservation(
      client,
      "2026-08-09 第1面 15:00～17:00",
      credentials,
    );

    expect(result.outcome).toBe("deadline-passed");
    expect(steps.map((s) => s.step)).not.toContain("confirmCancellation");
  });

  test("取消確認画面が別の予約を出していたら確定させない", async () => {
    const { steps, client } = stubClient({
      confirmScreen: cancelHtml.replace("2026/8/24(月)", "2026/8/31(月)"),
    });

    await expect(
      cancelReservation(client, TARGET, credentials),
    ).rejects.toThrow(/利用日/);
    expect(steps.map((s) => s.step)).not.toContain("confirmCancellation");
  });

  test("確定後も一覧に残っていたら失敗として扱う", async () => {
    // 取消完了画面の内容では判定しない。一覧から消えたことを確かめる
    const { client } = stubClient({ listAfter: listHtml });
    await expect(
      cancelReservation(client, TARGET, credentials),
    ).rejects.toThrow(/予約一覧/);
  });

  test("成功したら取消した予約を返す", async () => {
    const { client } = stubClient();
    const result = await cancelReservation(client, TARGET, credentials);

    expect(result.outcome).toBe("cancelled");
    expect(result.reservation?.date).toBe("2026-08-24");
  });
});
