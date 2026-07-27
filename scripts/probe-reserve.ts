/**
 * 予約フローの画面構造を採取する調査スクリプト（ローカル実行専用）。
 *
 * 既定では詳細申請画面（ログイン直後）までで止まる。
 * --confirm-screen を付けると詳細申請を送信して申込確認画面まで進むが、
 * **どちらの場合も「申込完了」に進む確定操作は行わないため予約は成立しない。**
 *
 * 実行:
 *   bun run scripts/probe-reserve.ts
 *   bun run scripts/probe-reserve.ts --confirm-screen
 *
 * 出力は利用者番号・氏名・トークンをマスクしてある（public リポジトリに
 * 貼っても事故らないようにするため）。
 */
import { parse } from "node-html-parser";
import { ToshimaClient, BASE_URL, MOKUTEKI } from "../src/client";
import { loadCredentials } from "../src/credentials";
import { slotKey } from "../src/notify";

const SOGO_TAIIKUJO = "116005";
const goToConfirmScreen = process.argv.includes("--confirm-screen");

// 申込確認画面に進むためだけの仮の入力。確定はしないので実害はない。
const PROBE_DETAILS = {
  ninzu: 2,
  mokuteki: MOKUTEKI.tennis,
  gyoujiMeishou: "テニス",
} as const;

const { userId, password } = loadCredentials();

/** 出力から個人情報とトークンを落とす。 */
function sanitize(text: string): string {
  return text
    .replaceAll(userId, "<userId>")
    .replace(/\S+\s*\S*\s*さん/g, "<name> さん")
    .replace(/[A-Za-z0-9_-]{40,}/g, "<token>");
}

function show(label: string, value: string | undefined | null): void {
  console.log(`${label}${value === undefined || value === null ? "" : sanitize(String(value))}`);
}

const client = new ToshimaClient();
await client.openStartPage();
await client.openSportsCategory();

const daily = await client.selectFacility(SOGO_TAIIKUJO);
const tennis = daily.filter((e) => e.roomName.includes("庭球"));
const openDays = tennis.filter((e) => e.status === "○" || e.status === "△");
if (openDays.length === 0) {
  console.log("空きがないため調査できません。空きのある時間帯に再実行してください");
  process.exit(0);
}

const slots = await client.openTimeSlots(openDays.map((e) => e.checkdateValue));
if (slots.length === 0) {
  console.log("空きコマがないため調査できません");
  process.exit(0);
}

const target = slots[0]!;
console.log(`調査対象のコマ: ${slotKey(target)}`);
console.log(
  goToConfirmScreen
    ? "※ 申込確認画面まで進みますが、確定操作は行わないため予約は成立しません\n"
    : "※ 詳細申請画面までで止まります（予約は成立しません）\n",
);

// コマを選んでログイン画面へ
await client.postBack(`${BASE_URL}/Yoyaku/WgR_JikantaibetsuAkiJoukyou`, "next", "", [
  ["checktime", target.checktimeValue],
]);

let html = await client.login(userId, password);
console.log("ログイン成功 → 詳細申請画面");

if (goToConfirmScreen) {
  html = await client.submitApplication(PROBE_DETAILS);
  console.log("詳細申請を送信 → 申込確認画面\n");
}

const root = parse(html);

show("=== title ===\n", root.querySelector("title")?.text.trim());

console.log("\n=== form ===");
for (const form of root.querySelectorAll("form")) {
  show("  ", `action=${form.getAttribute("action")} method=${form.getAttribute("method")}`);
}

console.log("\n=== input ===");
for (const input of root.querySelectorAll("input")) {
  const name = input.getAttribute("name");
  const value =
    name === "__RequestVerificationToken" ? "<token>" : input.getAttribute("value");
  show("  ", `type=${input.getAttribute("type")} name=${name} id=${input.getAttribute("id")} value=${value}`);
}

console.log("\n=== select ===");
for (const select of root.querySelectorAll("select")) {
  const options = select.querySelectorAll("option").map((o) => o.getAttribute("value"));
  show("  ", `name=${select.getAttribute("name")} options=${JSON.stringify(options.slice(0, 20))}`);
}

console.log("\n=== postback ターゲット ===");
const targets = new Set<string>();
for (const m of html.matchAll(/__doPostBack\(\s*['"]([^'"]+)['"]/g)) targets.add(m[1]!);
show("  ", [...targets].join(", "));

console.log("\n=== 押せる要素 ===");
for (const el of root.querySelectorAll("a[onclick], button, input[type=button], input[type=submit]")) {
  const label = el.getAttribute("value") ?? el.text.trim();
  show("  ", `${el.tagName} name=${el.getAttribute("name")} label=${label.slice(0, 30)} onclick=${el.getAttribute("onclick")?.slice(0, 80)}`);
}

console.log("\n=== 本文抜粋 ===");
show(
  "",
  html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1500),
);
