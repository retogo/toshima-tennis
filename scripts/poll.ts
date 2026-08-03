/**
 * 空き状況をポーリングして通知する（Cloud Run Job）。
 *
 * Cloud Scheduler から定期実行される。状態（前回の空き状況・予約済みコマ）は
 * GCS に置き、実行をまたいで持ち回す。
 *
 * 空き通知は「希望条件に一致するコマが前回から変わったとき」だけ送る。
 * 全コマを見ると興味のない曜日・時間帯の増減でも鳴ってしまうため。
 *
 * mode（reserve.json）で挙動が変わる。
 *   notify  … 通知のみ
 *   approve … 候補をボタン付きで通知し、押されたら reserve Job が動く
 *   auto    … その場で予約を確定する
 */
import { ToshimaClient } from "../src/client";
import { parseConfig, type ReserveConfig } from "../src/config";
import { cancellationDeadline } from "../src/confirmation";
import { loadCredentials } from "../src/credentials";
import {
  buildCandidateMessage,
  buildReservedMessage,
  pushMessage,
  pushMessages,
} from "../src/line";
import { notifiableSlots } from "../src/notifiable";
import {
  buildSignature,
  decideNotification,
  formatBody,
  formatGoneBody,
  slotKey,
  subjectFor,
} from "../src/notify";
import { parseReservations, reservationKey } from "../src/reservations";
import { reserveSlot } from "../src/reserve";
import { stateStoreFromEnv } from "../src/state";
import { parseTracked, serializeTracked, trackReservation } from "../src/tracked";
import { TRACKED_KEY } from "../src/dispatch";
import { matchingSlots, selectSlotsToReserve } from "../src/wishlist";
import type { TimeSlot } from "../src/parser";

const SOGO_TAIIKUJO = "116005";
const LAST_KEY = "last.txt";
const CONFIG_FILE = process.env.RESERVE_CONFIG ?? "reserve.json";

/** Cloud Run は UTC で動くため、日付は JST に直して扱う。 */
function today(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(
    new Date(),
  );
}

/** 承認しなかった場合に自動取消される日（取消期限の bufferDays 日前）。 */
function cancelDay(slotKey: string, bufferDays: number): string {
  const deadline = new Date(`${cancellationDeadline(slotKey.slice(0, 10))}T00:00:00Z`);
  deadline.setUTCDate(deadline.getUTCDate() - bufferDays);
  return deadline.toISOString().slice(0, 10);
}

const dryRun = process.env.RESERVE_DRY_RUN === "1";
const state = stateStoreFromEnv();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`環境変数 ${name} が設定されていません`);
  return value;
}

const lineToken = required("LINE_CHANNEL_ACCESS_TOKEN");
const lineTo = required("LINE_TO");

async function loadConfig(): Promise<ReserveConfig | undefined> {
  const file = Bun.file(CONFIG_FILE);
  return (await file.exists()) ? parseConfig(await file.text()) : undefined;
}

/**
 * 空き照会をひととおり辿り、庭球場の空きコマを返す。
 * 予約時はセッションを取り直すために再度呼ぶので、そのときは出力しない。
 */
async function fetchOpenSlots(
  client: ToshimaClient,
  quiet = false,
): Promise<TimeSlot[]> {
  await client.openStartPage();
  await client.openSportsCategory();

  const daily = await client.selectFacility(SOGO_TAIIKUJO);
  const tennis = daily.filter((e) => e.roomName.includes("庭球"));

  if (!quiet) {
    console.log("=== 総合体育場 庭球場 日別空き状況 ===");
    for (const entry of tennis) {
      console.log(`${entry.date}: ${entry.status}`);
    }
  }

  const openDays = tennis.filter((e) => e.status === "○" || e.status === "△");
  if (openDays.length === 0) return [];
  return client.openTimeSlots(openDays.map((e) => e.checkdateValue));
}

const config = await loadConfig();
const slots = await fetchOpenSlots(new ToshimaClient());

/**
 * 予約済みのコマ。**サイトの予約一覧が真実の源。**
 *
 * 状態ファイルはこのツールが取った分しか知らず、手動で取った予約を数え落とす。
 * 実際に記録されていない手動予約が 1 件あり、月上限が意図どおり効かない状態に
 * なっていた。auto モードでは月上限がそのまま支出の上限になるため、予約する前に
 * サイトを見る。
 *
 * ログインが必要なので、認証情報を持つ auto モードのときだけ問い合わせる。
 */
async function readReservedKeys(): Promise<string[]> {
  if (config?.mode !== "auto") return [];

  const client = new ToshimaClient();
  const credentials = loadCredentials();
  const menu = await client.loginFromTop(credentials.userId, credentials.password);
  const list = await client.openReservations(menu);
  const reservations = parseReservations(list);

  console.log(`\n=== 予約済み ${reservations.length} 件（サイト） ===`);
  for (const r of reservations) {
    console.log(
      `  ${reservationKey(r)}${r.cancelValue ? "" : "（取消期限切れ）"}`,
    );
  }
  return reservations.map(reservationKey);
}

const alreadyReserved = await readReservedKeys();

console.log(`\n=== 空きコマ ${slots.length} 件 ===`);
console.log(buildSignature(slots) || "  なし");

const notifiable = notifiableSlots(slots, config?.wishlist, alreadyReserved);
const signature = buildSignature(notifiable);
console.log(`\n=== うち通知対象 ${notifiable.length} 件 ===`);
console.log(signature || "  なし");

// --- 予約（reserve.json があるときだけ） ---
const reservedKeys: string[] = [];
let candidates: string[] = [];

if (config && slots.length > 0) {
  const targets = selectSlotsToReserve(slots, config.wishlist, alreadyReserved);
  console.log(
    `\n=== 予約（mode=${config.mode}） ===\n対象 ${targets.length} 件${dryRun ? "（dry-run）" : ""}`,
  );

  if (config.mode === "approve" && targets.length > 0) {
    // 候補をボタンで出し、押されたら reserve Job が動く
    candidates = matchingSlots(slots, config.wishlist, alreadyReserved).map(slotKey);
    for (const key of candidates) console.log(`  候補: ${key}`);
  } else if (config.mode === "auto") {
    const credentials = loadCredentials();
    for (const slot of targets) {
      // 申込完了後に別のコマを続けて予約できるかは未確認なので、
      // コマごとにセッションを取り直して確実に同じ手順を踏む。
      const client = new ToshimaClient();
      await fetchOpenSlots(client, true);
      await reserveSlot(client, slot, credentials, config.application, { dryRun });
      if (!dryRun) {
        reservedKeys.push(slotKey(slot));
        console.log(`予約しました: ${slotKey(slot)}`);
      }
    }

    // 自動で取った予約を未承認として記録する。承認されないまま取消期限が
    // 近づいたものを cancel Job が取り消す。**記録に無い予約は取り消さない**ため、
    // ここで記録を落とすと自動取消も効かなくなる。
    if (reservedKeys.length > 0) {
      let tracked = parseTracked(await state.read(TRACKED_KEY));
      for (const key of reservedKeys) tracked = trackReservation(tracked, key, today());
      await state.write(TRACKED_KEY, serializeTracked(tracked));
    }
  } else {
    for (const slot of targets) {
      console.log(`  条件に一致（通知のみ・予約しません）: ${slotKey(slot)}`);
    }
  }
}

// --- 通知と状態保存 ---
const previous = await state.read(LAST_KEY);
const decision = decideNotification(signature, previous, {
  reservedCount: reservedKeys.length,
  hasPending: candidates.length > 0,
});

// 予約済みコマの記録は持たない。サイトの予約一覧を読むほうが確実で、
// 手動で取った予約も数に入る（reserved.txt はこのツールの分しか知らなかった）。
await state.write(LAST_KEY, signature);

if (decision.kind === "none") {
  console.log("\n通知なし");
  process.exit(0);
}

const now = new Date();
const subject = subjectFor(decision.kind);

if (decision.kind === "pending") {
  await pushMessages(lineToken, lineTo, [
    buildCandidateMessage(subject, candidates, {
      note: "ボタンを押すとその場で予約が確定します。取消は使用日の1週間前（同一曜日）まで。",
    }),
  ]);
} else if (decision.kind === "reserved") {
  // 自動で取った予約は、承認しないと期限前に自動で取り消される。
  // 承認・取消のボタンと、いつ取り消されるかを一緒に出す。
  const buffer = config?.cancelBufferDays ?? 2;
  const cancelOn = cancelDay(reservedKeys[0]!, buffer);
  await pushMessages(lineToken, lineTo, [
    buildReservedMessage(subject, reservedKeys, cancelOn),
  ]);
} else {
  // gone は「なくなったコマ」を出すため、今回ではなく前回の署名から本文を作る
  const body =
    decision.kind === "gone"
      ? formatGoneBody(previous, now)
      : formatBody(signature, now);
  await pushMessage(lineToken, lineTo, `${subject}\n\n${body}`);
}

console.log(`\nLINE に通知しました（${decision.kind}）`);
