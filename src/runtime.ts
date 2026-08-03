/**
 * 実行時に変えられる設定と、LINE に返す状況表示。
 *
 * `reserve.json` はコンテナイメージに焼き込まれているので、LINE から動作モードを
 * 変えるには可変の置き場が必要になる。GCS に上書きを置き、poll は
 * 「上書きがあればそれを使い、無ければ reserve.json」の順で読む。
 *
 * 予約一覧は poll が取得してスナップショットとして置く。**webhook には予約
 * システムの認証情報を置かない**ので、webhook 自身は一覧を取りに行けない。
 * 置いてあるものを読んで応答するだけにする（応答は LINE の無料枠を消費しない）。
 */
import { cancellationDeadline } from "./confirmation";
import type { ReserveMode } from "./config";
import { reservationKey, type Reservation } from "./reservations";
import type { TrackedState } from "./tracked";

/** 予約一覧スナップショットの置き場 */
export const SNAPSHOT_KEY = "reservations.json";

export interface ReservationSnapshot {
  /** 取得時刻（ISO 8601）。キャッシュの古さを伝えるために持つ */
  takenAt: string;
  reservations: Reservation[];
  /**
   * 取得時点の cancelBufferDays。webhook は reserve.json の解釈を持たないため、
   * 設定を知っている poll 側から渡す。
   */
  cancelBufferDays?: number;
}

/** 壊れていたら undefined。一覧が出ないだけで済ませる。 */
export function parseSnapshot(text: string): ReservationSnapshot | undefined {
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as ReservationSnapshot;
  } catch {
    return undefined;
  }
}

export function serializeSnapshot(snapshot: ReservationSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

function toJst(at: Date): string {
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
  return `${formatted} JST`;
}

/** "2026-08-17" から days 日引く。 */
function minusDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - days);
  return at.toISOString().slice(0, 10);
}

export interface StatusInput {
  mode: ReserveMode;
  /** undefined は「まだ取得できていない」 */
  reservations: Reservation[] | undefined;
  tracked: TrackedState;
  cancelBufferDays: number;
  takenAt?: Date;
}

/**
 * 現在の状況（モード・予約一覧・取消期限）を人が読める形にする。
 *
 * 予約ごとに「ウェブから取り消せるか」「自動取消の対象か」を出す。この 2 つは
 * 別物で、混ざると判断を誤る。
 *   - 取消期限を過ぎた予約はサイトが取消を受け付けない（窓口・電話のみ）
 *   - 記録に無い予約（手動で取ったもの）は自動取消の対象にならない
 */
export function formatStatus(input: StatusInput, at: Date): string {
  const lines = [
    input.mode === "auto" ? "自動で予約します" : "押したら予約します",
  ];

  if (!input.reservations) {
    lines.push("", "予約一覧をまだ取得できていません");
    return lines.join("\n");
  }

  if (input.reservations.length === 0) {
    lines.push("", "予約はありません");
    return lines.join("\n");
  }

  const sorted = [...input.reservations].sort(
    (a, b) => a.date.localeCompare(b.date) || a.timeRange.localeCompare(b.timeRange),
  );

  for (const reservation of sorted) {
    const deadline = cancellationDeadline(reservation.date);
    const tracked = input.tracked[reservationKey(reservation)];
    const expired = reservation.cancelValue ? "" : "（期限切れ）";

    // 「取消できるか」はサイトの判断、「自動取消の対象か」はツールの記録。
    // 別物なので行を分ける。混ぜると判断を誤る。
    lines.push(
      "",
      `${reservation.date} ${reservation.timeRange}`,
      `${reservation.feeYen.toLocaleString()}円 / 取消期限 ${deadline}${expired}`,
      !tracked
        ? "手動の予約（自動取消しません）"
        : tracked.approved
          ? "承認済み（自動取消しません）"
          : `未承認 / ${minusDays(deadline, input.cancelBufferDays)} に自動取消`,
    );
  }

  if (input.takenAt) lines.push("", `${toJst(input.takenAt)} 時点`);

  return lines.join("\n");
}
