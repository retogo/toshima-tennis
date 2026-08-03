import { test, expect, describe } from "bun:test";
import {
  CANCELLED_SUBJECT,
  buildSignature,
  formatCancellationBody,
  decideNotification,
  formatBody,
  formatGoneBody,
  formatReservationBody,
  subjectFor,
  RESERVATION_URL,
} from "./notify";
import type { TimeSlot } from "./parser";

function slot(overrides: Partial<TimeSlot> = {}): TimeSlot {
  return {
    roomCode: "00502",
    date: "2026-07-30",
    courtNo: "02",
    timeRange: "11:00～13:00",
    checktimeValue: "00502202607300211:00～13:00",
    ...overrides,
  };
}

describe("buildSignature", () => {
  test("空きコマを人が読める行に正規化する（面番号の先頭ゼロを落とす）", () => {
    expect(buildSignature([slot()])).toBe("2026-07-30 第2面 11:00～13:00");
  });

  test("並び順が違っても同じ署名になる", () => {
    const a = [slot({ courtNo: "03" }), slot({ courtNo: "01" })];
    const b = [slot({ courtNo: "01" }), slot({ courtNo: "03" })];
    expect(buildSignature(a)).toBe(buildSignature(b));
  });

  test("空きなしは空文字列", () => {
    expect(buildSignature([])).toBe("");
  });

  test("時刻の早い順に並べる（9:00 を 11:00 より前に置く）", () => {
    const nine = slot({ timeRange: "9:00～11:00", courtNo: "01" });
    const eleven = slot({ timeRange: "11:00～13:00", courtNo: "01" });
    expect(buildSignature([eleven, nine]).split("\n")).toEqual([
      "2026-07-30 第1面 9:00～11:00",
      "2026-07-30 第1面 11:00～13:00",
    ]);
  });

  test("日付をまたぐ場合は日付を優先して並べる", () => {
    const later = slot({ date: "2026-08-01", timeRange: "9:00～11:00" });
    const earlier = slot({ date: "2026-07-30", timeRange: "15:00～17:00" });
    const [first] = buildSignature([later, earlier]).split("\n");
    expect(first).toContain("2026-07-30");
  });
});

describe("decideNotification", () => {
  test("空きが新しく出たら通知する", () => {
    const d = decideNotification("2026-07-30 第2面 11:00～13:00", "");
    expect(d).toEqual({
      hasAvailability: true,
      stateChanged: true,
      shouldEmail: true,
      kind: "availability",
    });
  });

  test("前回と同じ空きなら通知しない（スパム防止）", () => {
    const sig = "2026-07-30 第2面 11:00～13:00";
    const d = decideNotification(sig, sig);
    expect(d).toEqual({
      hasAvailability: true,
      stateChanged: false,
      shouldEmail: false,
      kind: "none",
    });
  });

  test("空きの内容が変わったら再通知する", () => {
    const d = decideNotification(
      "2026-07-30 第2面 11:00～13:00\n2026-07-31 第1面 9:00～11:00",
      "2026-07-30 第2面 11:00～13:00",
    );
    expect(d.shouldEmail).toBe(true);
  });

  test("空きが消えたら状態を更新し、なくなったことを通知する", () => {
    // 送信済みのボタン付き通知を無効化する手段が通知しかないため、
    // ここで黙ると押しても予約できないボタンが残ったままになる。
    const d = decideNotification("", "2026-07-30 第2面 11:00～13:00");
    expect(d).toEqual({
      hasAvailability: false,
      stateChanged: true,
      shouldEmail: true,
      kind: "gone",
    });
  });

  test("空きなしが続く間は何も起きない", () => {
    expect(decideNotification("", "")).toEqual({
      hasAvailability: false,
      stateChanged: false,
      shouldEmail: false,
      kind: "none",
    });
  });
});

describe("decideNotification: 予約が成立したとき", () => {
  test("唯一の空きを予約して空きが 0 になっても必ず通知する", () => {
    // 予約した結果 signature が空になるケース。ここで黙るのが従来の穴だった。
    const d = decideNotification("", "2026-08-08 第1面 9:00～11:00", { reservedCount: 1 });
    expect(d.shouldEmail).toBe(true);
    expect(d.kind).toBe("reserved");
  });

  test("空き状況が前回から変わっていなくても通知する", () => {
    const sig = "2026-08-08 第1面 9:00～11:00";
    const d = decideNotification(sig, sig, { reservedCount: 1 });
    expect(d.stateChanged).toBe(false);
    expect(d.shouldEmail).toBe(true);
    expect(d.kind).toBe("reserved");
  });

  test("予約が 0 件なら従来の空き通知の判定に従う", () => {
    expect(decideNotification("x", "", { reservedCount: 0 }).kind).toBe("availability");
    expect(decideNotification("x", "x", { reservedCount: 0 }).kind).toBe("none");
  });
});

describe("decideNotification: 承認待ちのとき", () => {
  test("候補が新しく出たらボタン付きで通知する", () => {
    const d = decideNotification("2026-08-08 第1面 9:00～11:00", "", {
      hasPending: true,
    });
    expect(d.shouldEmail).toBe(true);
    expect(d.kind).toBe("pending");
  });

  test("候補が前回と同じなら通知しない（10 分ごとの再送を止める）", () => {
    // approve モードでは候補がある間ずっと hasPending が立つ。変化検知を通さないと
    // ポーリングのたびに push され、月 200 通の無料枠を 2 日で使い切る。
    const sig = "2026-08-08 第1面 9:00～11:00";
    const d = decideNotification(sig, sig, { hasPending: true });
    expect(d.stateChanged).toBe(false);
    expect(d.shouldEmail).toBe(false);
    expect(d.kind).toBe("none");
  });

  test("候補が増えたら再通知する", () => {
    const d = decideNotification(
      "2026-08-08 第1面 9:00～11:00\n2026-08-09 第2面 17:00～19:00",
      "2026-08-08 第1面 9:00～11:00",
      { hasPending: true },
    );
    expect(d.shouldEmail).toBe(true);
    expect(d.kind).toBe("pending");
  });

  test("予約が成立していれば承認待ちより予約通知を優先する", () => {
    const d = decideNotification("", "x", { reservedCount: 1, hasPending: true });
    expect(d.kind).toBe("reserved");
  });

  test("予約成立の通知は候補と違い、変化していなくても送る", () => {
    const sig = "2026-08-08 第1面 9:00～11:00";
    expect(decideNotification(sig, sig, { reservedCount: 1 }).kind).toBe("reserved");
  });

  test("承認待ちが無ければ従来どおり", () => {
    expect(decideNotification("x", "", {}).kind).toBe("availability");
  });
});

describe("decideNotification: 候補がなくなったとき", () => {
  // 送信済みメッセージを編集する API は LINE に無いため、ボタンが使えなく
  // なったことは新しい通知で伝えるしかない。
  test("候補が 0 件になったら通知する", () => {
    const d = decideNotification("", "2026-08-09 第2面 17:00～19:00");
    expect(d.hasAvailability).toBe(false);
    expect(d.shouldEmail).toBe(true);
    expect(d.kind).toBe("gone");
  });

  test("0 件が続く間は通知しない", () => {
    expect(decideNotification("", "")).toEqual({
      hasAvailability: false,
      stateChanged: false,
      shouldEmail: false,
      kind: "none",
    });
  });

  test("自分の予約で 0 件になった場合は予約通知を優先する", () => {
    const d = decideNotification("", "2026-08-08 第1面 9:00～11:00", {
      reservedCount: 1,
    });
    expect(d.kind).toBe("reserved");
  });

  test("候補が減っただけなら候補通知のまま", () => {
    const d = decideNotification(
      "2026-08-09 第2面 17:00～19:00",
      "2026-08-09 第2面 17:00～19:00\n2026-08-09 第4面 17:00～19:00",
      { hasPending: true },
    );
    expect(d.kind).toBe("pending");
  });
});

describe("subjectFor", () => {
  test("予約と空き検知で件名を区別する", () => {
    expect(subjectFor("reserved")).not.toBe(subjectFor("availability"));
    expect(subjectFor("reserved")).toContain("予約");
  });

  test("候補がなくなった通知は他と区別できる", () => {
    expect(subjectFor("gone")).not.toBe(subjectFor("availability"));
    expect(subjectFor("gone")).not.toBe(subjectFor("pending"));
  });
});

describe("formatGoneBody", () => {
  const at = new Date("2026-07-27T09:30:00Z"); // JST 18:30

  test("なくなったコマを列挙する", () => {
    const body = formatGoneBody(
      "2026-08-09 第2面 17:00～19:00\n2026-08-09 第4面 17:00～19:00",
      at,
    );
    expect(body).toContain("・2026-08-09 第2面 17:00～19:00");
    expect(body).toContain("・2026-08-09 第4面 17:00～19:00");
  });

  test("先に送ったボタンが使えないことを伝える", () => {
    // 送信済みメッセージは編集できないので、本文で無効になった旨を伝える
    const body = formatGoneBody("2026-08-09 第2面 17:00～19:00", at);
    expect(body).toContain("ボタン");
  });

  test("埋まったと断定しない（候補日が過ぎた場合もある）", () => {
    const body = formatGoneBody("2026-08-09 第2面 17:00～19:00", at);
    expect(body).not.toContain("埋まりました");
  });

  test("最終確認時刻を JST で表示する", () => {
    expect(formatGoneBody("x", at)).toContain("2026-07-27 18:30 JST");
  });
});

describe("formatReservationBody", () => {
  const at = new Date("2026-07-27T09:30:00Z"); // JST 18:30

  test("予約が成立した旨を明記する（空き通知と紛れないように）", () => {
    const body = formatReservationBody(["2026-08-08 第1面 9:00～11:00"], at);
    expect(body).toContain("予約しました");
  });

  test("予約したコマを列挙する", () => {
    const body = formatReservationBody(
      ["2026-08-08 第1面 9:00～11:00", "2026-08-09 第2面 11:00～13:00"],
      at,
    );
    expect(body).toContain("・2026-08-08 第1面 9:00～11:00");
    expect(body).toContain("・2026-08-09 第2面 11:00～13:00");
  });

  test("取り消しは予約システム側で行う旨を案内する", () => {
    const body = formatReservationBody(["2026-08-08 第1面 9:00～11:00"], at);
    expect(body).toContain(RESERVATION_URL);
    expect(body).toContain("取消");
  });

  test("コマごとの取消期限（使用日の 1 週間前）を示す", () => {
    const body = formatReservationBody(["2026-08-08 第1面 9:00～11:00"], at);
    expect(body).toContain("2026-08-01");
  });

  test("実行時刻を JST で表示する", () => {
    expect(
      formatReservationBody(["2026-08-08 第1面 9:00～11:00"], at),
    ).toContain("2026-07-27 18:30 JST");
  });
});

describe("formatBody", () => {
  const at = new Date("2026-07-27T09:30:00Z"); // JST 18:30

  test("空きコマを箇条書きにする", () => {
    const body = formatBody("2026-07-30 第2面 11:00～13:00", at);
    expect(body).toContain("・2026-07-30 第2面 11:00～13:00");
  });

  test("最終確認時刻を JST で表示する", () => {
    expect(formatBody("x", at)).toContain("2026-07-27 18:30 JST");
  });

  test("予約システムの URL を含める", () => {
    expect(formatBody("x", at)).toContain(
      "https://www2.pf489.com/toshima/WebR",
    );
  });
});

describe("formatCancellationBody", () => {
  const at = new Date("2026-08-03T09:30:00Z"); // JST 18:30

  test("取り消したコマと理由を示す", () => {
    const body = formatCancellationBody(
      "2026-08-24 第4面 9:00～11:00",
      "承認がなかったため",
      at,
    );
    expect(body).toContain("2026-08-24 第4面 9:00～11:00");
    expect(body).toContain("承認がなかったため");
  });

  test("取り消した旨を明記する（予約通知と紛れないように）", () => {
    expect(
      formatCancellationBody("2026-08-24 第4面 9:00～11:00", "手動操作", at),
    ).toContain("取り消しました");
  });

  test("実行時刻を JST で表示する", () => {
    expect(
      formatCancellationBody("2026-08-24 第4面 9:00～11:00", "手動操作", at),
    ).toContain("2026-08-03 18:30 JST");
  });
});

describe("CANCELLED_SUBJECT", () => {
  test("予約通知・空き通知と区別できる", () => {
    expect(CANCELLED_SUBJECT).not.toBe(subjectFor("reserved"));
    expect(CANCELLED_SUBJECT).toContain("取消");
  });
});
