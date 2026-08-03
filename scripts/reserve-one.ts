/**
 * 1 コマだけ予約する（Cloud Run Job）。
 *
 * LINE のボタンが押されると webhook がこの Job を起動し、RESERVE_SLOT に
 * 予約するコマを渡す。押されてから実行されるまでに時間が空くため、
 * **その時点でまだ空いているとは限らない**。埋まっていれば予約せず終了する。
 *
 * ローカル実行:
 *   RESERVE_SLOT="2026-08-08 第1面 9:00～11:00" bun run scripts/reserve-one.ts
 */
import { ToshimaClient } from "../src/client";
import { parseConfig } from "../src/config";
import { loadCredentials } from "../src/credentials";
import { pushMessage } from "../src/line";
import { formatReservationBody, slotKey, subjectFor } from "../src/notify";
import {
  findReservation,
  parseReservations,
  reservationKey,
} from "../src/reservations";
import { reserveSlot } from "../src/reserve";
import { reservedCountInMonth } from "../src/wishlist";

const SOGO_TAIIKUJO = "116005";
const CONFIG_FILE = process.env.RESERVE_CONFIG ?? "reserve.json";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`環境変数 ${name} が設定されていません`);
  return value;
}

const wanted = required("RESERVE_SLOT");
const lineToken = required("LINE_CHANNEL_ACCESS_TOKEN");
const lineTo = required("LINE_TO");

const dryRun = process.env.RESERVE_DRY_RUN === "1";

const config = parseConfig(await Bun.file(CONFIG_FILE).text());
const credentials = loadCredentials();

/** 結果を LINE に返して終了する。 */
async function finish(text: string): Promise<never> {
  console.log(text);
  await pushMessage(lineToken, lineTo, text);
  process.exit(0);
}

/**
 * すでに予約している件数を確かめる。**サイトの予約一覧が真実の源。**
 *
 * ボタンからの予約は poll の選択ロジック（月上限つき）を通らないため、ここで
 * 独立に上限を守る必要がある。状態ファイルを見ていた頃は、poll が書くのをやめた
 * あと常に空になり、**ボタン経由だと月上限が効かない**状態になっていた。
 *
 * 空き照会とは別のセッションで行う。`loginFromTop` がトップページから入り直すので、
 * 同じ client を使うと予約に必要な画面遷移が巻き戻ってしまう。
 */
const reservations = parseReservations(
  await (async () => {
    const session = new ToshimaClient();
    const menu = await session.loginFromTop(credentials.userId, credentials.password);
    return session.openReservations(menu);
  })(),
);
console.log(`予約済み ${reservations.length} 件（サイト）`);

const client = new ToshimaClient();
await client.openStartPage();
await client.openSportsCategory();

const daily = await client.selectFacility(SOGO_TAIIKUJO);
const tennis = daily.filter((e) => e.roomName.includes("庭球"));
const openDays = tennis.filter((e) => e.status === "○" || e.status === "△");
const slots =
  openDays.length > 0
    ? await client.openTimeSlots(openDays.map((e) => e.checkdateValue))
    : [];

const target = slots.find((s) => slotKey(s) === wanted);
if (!target) {
  // 押されてから実行されるまでに他の人に取られた場合。異常ではない。
  await finish(`⚠️ ${wanted}\n\n既に空きがなくなっていました。予約できていません。`);
}

if (findReservation(reservations, wanted)) {
  await finish(
    `⚠️ ${wanted}\n\n同じ利用日・時間帯の予約が既にあります。何もしませんでした。`,
  );
}

const usedThisMonth = reservedCountInMonth(
  reservations.map(reservationKey),
  target!.date,
);
if (usedThisMonth >= config.wishlist.maxPerMonth) {
  await finish(
    `⚠️ ${wanted}\n\n${target!.date.slice(0, 7)} は既に ${usedThisMonth} 件予約済みで、` +
      `上限（${config.wishlist.maxPerMonth} 件）に達しています。予約していません。`,
  );
}

await reserveSlot(client, target!, credentials, config.application, { dryRun });

if (dryRun) {
  await finish(`[dry-run] ${wanted}\n\n確定せずに中断しました。`);
}

await finish(
  `${subjectFor("reserved")}\n\n${formatReservationBody([wanted], new Date())}`,
);
