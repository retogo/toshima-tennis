/**
 * 承認されないまま取消期限が近づいた予約を取り消す（Cloud Run Job・日次）。
 *
 * 自動予約は「承認しなければ取り消す」運用にしてある。承認は LINE のボタンで、
 * 記録は `tracked.json`。
 *
 * **記録に無い予約は絶対に取り消さない。** 利用者が自分で取った予約を勝手に
 * 消してしまう事故を防ぐ。判定は `src/tracked.ts` の dueForCancellation。
 *
 * **期限当日まで待たない。** ジョブが失敗したときに取り返せるよう、期限の
 * `cancelBufferDays` 日前から取り消す（既定 2 日）。
 *
 * ローカル実行:
 *   CANCEL_DRY_RUN=1 bun run cancel:due
 */
import { cancelReservation } from "../src/cancel";
import { ToshimaClient } from "../src/client";
import { parseConfig } from "../src/config";
import { loadCredentials } from "../src/credentials";
import { TRACKED_KEY } from "../src/dispatch";
import { pushMessage } from "../src/line";
import { CANCELLED_SUBJECT, formatCancellationBody } from "../src/notify";
import { parseReservations } from "../src/reservations";
import { stateStoreFromEnv } from "../src/state";
import {
  dueForCancellation,
  forgetTracked,
  parseTracked,
  serializeTracked,
} from "../src/tracked";

const CONFIG_FILE = process.env.RESERVE_CONFIG ?? "reserve.json";
const REASON = "期限までに承認されなかったため";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`環境変数 ${name} が設定されていません`);
  return value;
}

const lineToken = required("LINE_CHANNEL_ACCESS_TOKEN");
const lineTo = required("LINE_TO");

const dryRun = process.env.CANCEL_DRY_RUN === "1";
const state = stateStoreFromEnv();
const config = parseConfig(await Bun.file(CONFIG_FILE).text());
const credentials = loadCredentials();

/** Cloud Run は UTC で動くため、判定に使う「今日」は JST に直す。 */
const today = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Tokyo",
}).format(new Date());

const tracked = parseTracked(await state.read(TRACKED_KEY));
const trackedCount = Object.keys(tracked).length;
console.log(`自動予約の記録 ${trackedCount} 件 / 判定日 ${today} JST`);

if (trackedCount === 0) {
  console.log("記録が無いため何もしません");
  process.exit(0);
}

// サイトの予約一覧と突き合わせる。取消可否もサイトの判断に従う。
const client = new ToshimaClient();
const menu = await client.loginFromTop(credentials.userId, credentials.password);
const reservations = parseReservations(await client.openReservations(menu));

const due = dueForCancellation(
  tracked,
  reservations,
  today,
  config.cancelBufferDays,
);

console.log(
  `取消対象 ${due.length} 件（取消期限の ${config.cancelBufferDays} 日前から対象）${dryRun ? "（dry-run）" : ""}`,
);
for (const t of due) console.log(`  ${t.slotKey}`);

if (due.length === 0) process.exit(0);

const cancelled: string[] = [];
const failed: { slotKey: string; message: string }[] = [];

for (const target of due) {
  try {
    // コマごとにセッションを取り直す。一覧の行インデックスは取消のたびに
    // ずれるため、取消のたびに読み直すのが確実。
    const result = await cancelReservation(
      new ToshimaClient(),
      target.slotKey,
      credentials,
      { dryRun },
    );
    console.log(`${target.slotKey}: ${result.outcome}`);

    if (result.outcome === "cancelled") cancelled.push(target.slotKey);
  } catch (e) {
    // 1 件の失敗で残りを止めない。期限が迫っているものを取りこぼすため。
    console.error(`${target.slotKey} の取消に失敗:`, (e as Error).message);
    failed.push({ slotKey: target.slotKey, message: (e as Error).message });
  }
}

if (!dryRun && cancelled.length > 0) {
  let updated = tracked;
  for (const key of cancelled) updated = forgetTracked(updated, key);
  await state.write(TRACKED_KEY, serializeTracked(updated));
}

const now = new Date();
const lines: string[] = [];

for (const key of cancelled) {
  lines.push(formatCancellationBody(key, REASON, now));
}

if (failed.length > 0) {
  // 取消できないまま期限を過ぎると窓口・電話でのキャンセル料が発生する。
  // 気づけるように必ず知らせる。
  lines.push(
    [
      "⚠️ 取消に失敗しました。予約システムで確認してください。",
      ...failed.map((f) => `  ・${f.slotKey}: ${f.message}`),
      "",
      "取消期限を過ぎると窓口または電話での受付となり、キャンセル料が発生します。",
    ].join("\n"),
  );
}

if (lines.length > 0) {
  await pushMessage(lineToken, lineTo, `${CANCELLED_SUBJECT}\n\n${lines.join("\n\n")}`);
  console.log("LINE に通知しました");
}
