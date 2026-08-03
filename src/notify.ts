import { cancellationDeadline } from "./confirmation";
import type { TimeSlot } from "./parser";

/**
 * 送るメールの種類。上から順に優先する。
 *   reserved     … 予約が成立した（空き状況の変化とは無関係に必ず送る）
 *   pending      … 承認待ちに入った/候補が変わった
 *   availability … 空きが新しく出た/変わった
 *   gone         … 候補が全部なくなった（先に送ったボタンが使えなくなった）
 *   none         … 送らない
 */
export type NotificationKind =
  | "reserved"
  | "pending"
  | "availability"
  | "gone"
  | "none";

export interface NotificationSignals {
  /** 今回の実行で予約が成立した件数 */
  reservedCount?: number;
  /** 承認待ちに回したコマがあるか */
  hasPending?: boolean;
}

export interface NotificationDecision {
  /** 今回の取得で空きコマが 1 つ以上あったか */
  hasAvailability: boolean;
  /** 空き内容が前回から変化したか（＝状態を保存し直すべきか） */
  stateChanged: boolean;
  /** メールを送るべきか */
  shouldEmail: boolean;
  /** 送るなら、どちらの内容で送るか */
  kind: NotificationKind;
}

const SUBJECTS: Record<Exclude<NotificationKind, "none">, string> = {
  reserved: "🎾 テニスコートを予約しました",
  pending: "🎾 土日のコートに空きが出ました",
  availability: "🎾 テニスコートに空きがあります",
  gone: "🎾 空き候補がなくなりました",
};

export function subjectFor(kind: Exclude<NotificationKind, "none">): string {
  return SUBJECTS[kind];
}

export const RESERVATION_URL = "https://www2.pf489.com/toshima/WebR";

/**
 * コマを人が読める一意な識別子にする。
 * 状態比較・予約済み判定・メール本文で共通して使う。
 */
export function slotKey(slot: TimeSlot): string {
  return `${slot.date} 第${Number(slot.courtNo)}面 ${slot.timeRange}`;
}

/**
 * コマを日時の早い順に並べるための比較関数。
 *
 * 時間帯は "9:00～11:00" のように時が 1 桁になることがあり、素朴な文字列比較では
 * "15:00" が "9:00" より前に来てしまう。開始時刻を分に直して比べる。
 */
export function compareChronologically(a: TimeSlot, b: TimeSlot): number {
  const start = (slot: TimeSlot) => {
    const [, hour, minute] = slot.timeRange.match(/^(\d{1,2}):(\d{2})/)!;
    return Number(hour) * 60 + Number(minute);
  };
  return (
    a.date.localeCompare(b.date) ||
    start(a) - start(b) ||
    Number(a.courtNo) - Number(b.courtNo)
  );
}

/**
 * 空きコマ一覧を、前回との比較に使う一意な「署名」文字列にする。
 * 取得順に左右されないよう日時順に並べてから連結する。空きなしは空文字列。
 * この並びはメール本文にもそのまま出るため、読みやすい時系列順にする。
 */
export function buildSignature(slots: TimeSlot[]): string {
  return [...slots].sort(compareChronologically).map(slotKey).join("\n");
}

/**
 * 前回の署名と比較して、通知すべきか・状態を保存すべきかを決める。
 *
 * 空き通知は、空きが続いている間は署名が変わらないため 1 回だけになる。
 *
 * 空きが 0 に落ちたときは `gone` を送る。**LINE には送信済みメッセージを編集する
 * API が無い**ため、先に送ったボタンが使えなくなったことは新しい通知で伝えるしか
 * ない。ここも 1 回だけで、0 が続く間は黙る。
 *
 * 承認待ち（approve モードの候補）も同じエッジ検知に乗せる。候補があること自体を
 * 条件にすると、候補が残っている間ポーリングのたびに push され続ける。実測で
 * 同じ候補が 10 分間隔で 6 回連続送信され、月 200 通の無料枠を溶かしかけた。
 * 候補集合は署名と同じ集合（notifiableSlots ＝ matchingSlots）から作られるため、
 * 署名が変わらない＝候補が変わっていない。
 *
 * 予約が成立した場合は別扱いで、**空き状況の変化にかかわらず必ず通知する**。
 * 予約するとそのコマは空き一覧から消えるため、唯一の空きを予約すると署名が
 * 空になり、空き通知の条件では黙ってしまうため。
 */
export function decideNotification(
  signature: string,
  previous: string,
  signals: NotificationSignals = {},
): NotificationDecision {
  const hasAvailability = signature !== "";
  const stateChanged = signature !== previous;

  let kind: NotificationKind = "none";
  if ((signals.reservedCount ?? 0) > 0) {
    kind = "reserved";
  } else if (signals.hasPending && stateChanged) {
    kind = "pending";
  } else if (hasAvailability && stateChanged) {
    kind = "availability";
  } else if (stateChanged && !hasAvailability) {
    // 空きが 0 に落ちたエッジ。signature が空で変化しているなら前回は空でない。
    kind = "gone";
  }

  return { hasAvailability, stateChanged, shouldEmail: kind !== "none", kind };
}

/**
 * GitHub Actions は UTC で動くため、本文の時刻は JST に直して出す。
 * sv-SE ロケールは "YYYY-MM-DD HH:mm" 形式になる。
 */
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

/**
 * 予約成立を知らせるメール本文。
 * 自動で押さえた以上、取り消しは利用者自身が行う必要があるため導線を必ず載せる。
 */
export function formatReservationBody(reservedKeys: string[], at: Date): string {
  return [
    "総合体育場 庭球場を自動で予約しました。",
    "",
    "■ 予約したコマ（括弧内は取消手続きの期限）",
    ...reservedKeys.map(
      (key) => `  ・${key}（〜${cancellationDeadline(key.slice(0, 10))}）`,
    ),
    "",
    "取消は使用日の1週間前（同一曜日）までに予約システムから手続きしてください。",
    "期限を過ぎると窓口または電話での受付となり、キャンセル料が発生します。",
    `予約システム: ${RESERVATION_URL}`,
    `実行時刻: ${toJst(at)}`,
  ].join("\n");
}

/**
 * 候補が全部なくなったことを知らせる本文。
 *
 * LINE には送信済みメッセージを編集する API が無いので、先に送ったボタン付きの
 * 通知をこの通知で無効化する。0 になる理由は他の人に取られた場合だけでなく
 * 候補日が過ぎた場合もあるため、「埋まった」と断定しない。
 *
 * @param previous 直前の署名（＝なくなったコマの一覧）
 */
export function formatGoneBody(previous: string, at: Date): string {
  return [
    "希望条件に一致する空きがなくなりました。",
    "",
    "■ なくなったコマ",
    ...previous.split("\n").map((line) => `  ・${line}`),
    "",
    "先にお送りした通知のボタンは、押しても予約できません。",
    "他の人に予約されたか、候補の日付が過ぎたためです。",
    `予約システム: ${RESERVATION_URL}`,
    `最終確認: ${toJst(at)}`,
  ].join("\n");
}

/** メール本文を組み立てる。signature は buildSignature の出力。 */
export function formatBody(signature: string, at: Date): string {
  return [
    "総合体育場 庭球場に空きが見つかりました。",
    "",
    "■ 空きコマ",
    ...signature.split("\n").map((line) => `  ・${line}`),
    "",
    `予約システム: ${RESERVATION_URL}`,
    `最終確認: ${toJst(at)}`,
  ].join("\n");
}
