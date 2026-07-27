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
import { loadCredentials } from "../src/credentials";
import { buildCandidateMessage, pushMessage, pushMessages } from "../src/line";
import { notifiableSlots } from "../src/notifiable";
import {
  buildSignature,
  decideNotification,
  formatBody,
  formatReservationBody,
  slotKey,
  subjectFor,
} from "../src/notify";
import { reserveSlot } from "../src/reserve";
import { stateStoreFromEnv } from "../src/state";
import { matchingSlots, selectSlotsToReserve } from "../src/wishlist";
import type { TimeSlot } from "../src/parser";

const SOGO_TAIIKUJO = "116005";
const LAST_KEY = "last.txt";
const RESERVED_KEY = "reserved.txt";
const CONFIG_FILE = process.env.RESERVE_CONFIG ?? "reserve.json";

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

const alreadyReserved = (await state.read(RESERVED_KEY))
  .split("\n")
  .filter(Boolean);

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

await state.write(LAST_KEY, signature);
if (reservedKeys.length > 0) {
  await state.write(RESERVED_KEY, [...alreadyReserved, ...reservedKeys].join("\n"));
}

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
} else {
  const body =
    decision.kind === "reserved"
      ? formatReservationBody(reservedKeys, now)
      : formatBody(signature, now);
  await pushMessage(lineToken, lineTo, `${subject}\n\n${body}`);
}

console.log(`\nLINE に通知しました（${decision.kind}）`);
