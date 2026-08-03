/**
 * 予約内容の確認・取消フローの画面構造を採取する調査スクリプト（ローカル実行専用）。
 *
 * **このスクリプトは取消を実行しない。** 画面を読むだけで、取消の確定操作に
 * 相当する postback は一切送らない。取消は不可逆（取り消したコマは他の人に
 * 取られる）なので、実行は専用の経路に分ける。
 *
 * 空き照会と違い、トップページから直接ログインする（`login` postback）。
 * コマ選択を経る必要はない。
 *
 * 実行:
 *   bun run probe:cancel              # マイメニューの構造を採取
 *   bun run probe:cancel --yoyaku     # 予約内容の確認画面まで進んで採取
 *   bun run probe:cancel --yoyaku --select  # 取消確認画面まで進んで採取（確定はしない）
 *
 * 出力は利用者番号・氏名・トークンをマスクしてある。
 */
import { parse } from "node-html-parser";
import { BASE_URL, ToshimaClient } from "../src/client";
import { loadCredentials } from "../src/credentials";
import { parseReservations } from "../src/reservations";

const goToReservations = process.argv.includes("--yoyaku");

const { userId, password } = loadCredentials();

/** 出力から個人情報とトークンを落とす。 */
function sanitize(text: string): string {
  return text
    .replaceAll(userId, "<userId>")
    .replace(/\S+\s*\S*\s*さん/g, "<name> さん")
    .replace(/[A-Za-z0-9_-]{40,}/g, "<token>");
}

function show(label: string, value: string | undefined | null): void {
  console.log(
    `${label}${value === undefined || value === null ? "" : sanitize(String(value))}`,
  );
}

/**
 * 採取した HTML の保存先。ログインを繰り返さずに解析できるようにする。
 * 個人情報をマスクしてから書く。
 */
const saveDir = process.env.PROBE_SAVE_DIR;

/** 画面の構造（押せる要素・postback ターゲット・本文）を吐く。 */
async function dump(title: string, html: string, slug: string): Promise<void> {
  const root = parse(html);

  console.log(`\n${"=".repeat(60)}\n${title}\n${"=".repeat(60)}`);
  show("title: ", root.querySelector("title")?.text.trim());
  show("form action: ", root.querySelector("form")?.getAttribute("action"));

  if (saveDir) {
    const path = `${saveDir}/${slug}.html`;
    await Bun.write(path, sanitize(html));
    console.log(`保存: ${path}`);
  }

  console.log("\n--- postback ターゲット ---");
  const targets = new Set<string>();
  for (const m of html.matchAll(/__doPostBack\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]/g)) {
    targets.add(`${m[1]}:${m[2]}`);
  }
  show("  ", [...targets].join("  ") || "(なし)");

  console.log("\n--- input / select ---");
  for (const input of root.querySelectorAll("input")) {
    const name = input.getAttribute("name");
    if (!name) continue;
    const value =
      name === "__RequestVerificationToken" ? "<token>" : input.getAttribute("value");
    show("  ", `type=${input.getAttribute("type")} name=${name} value=${value}`);
  }
  for (const select of root.querySelectorAll("select")) {
    const options = select.querySelectorAll("option").map((o) => o.getAttribute("value"));
    show("  ", `select name=${select.getAttribute("name")} options=${JSON.stringify(options.slice(0, 20))}`);
  }

  console.log("\n--- 押せる要素 ---");
  for (const el of root.querySelectorAll("a[onclick], a[href], button, input[type=button], input[type=submit]")) {
    const label = (el.getAttribute("value") ?? el.text).trim().replace(/\s+/g, " ");
    if (!label) continue;
    const action = el.getAttribute("onclick") ?? el.getAttribute("href");
    show("  ", `${label.slice(0, 24)} → ${action?.slice(0, 90)}`);
  }

  console.log("\n--- 本文抜粋 ---");
  show(
    "",
    html
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<style[\s\S]*?<\/style>/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1200),
  );
}

/**
 * 画面の form action を実 URL に直して返す。
 * ログイン後に遷移する先を決め打ちにすると、画面が増えたときに追従できない。
 */
function formAction(html: string): string {
  const action = parse(html).querySelector("form")?.getAttribute("action");
  if (!action) throw new Error("form action が見つかりません");
  return new URL(action, BASE_URL).toString();
}

console.log("※ このスクリプトは取消を実行しない（画面を読むだけ）\n");

const client = new ToshimaClient();
await client.openStartPage();

// トップページから直接ログイン画面へ（コマ選択は経由しない）
await client.postBack(`${BASE_URL}/Home/WgR_ModeSelect`, "login", "");
const menu = await client.login(userId, password);
await dump("ログイン後の画面", menu, "menu");

if (!goToReservations) {
  console.log(
    "\n予約内容の確認画面まで進むには --yoyaku を付けて実行してください（取消は実行しません）",
  );
  process.exit(0);
}

// 「予約内容の確認・取消」へ。表示するだけで、取消の確定は送らない。
const reservations = await client.postBack(formAction(menu), "yoyaku", "");
await dump("予約内容の確認・取消", reservations, "yoyaku-list");

const parsed = parseReservations(reservations);
console.log("\n=== 読み取った予約 ===");
for (const r of parsed) {
  console.log(
    `  ${r.date} ${r.timeRange} ${r.feeYen}円 ${r.status}` +
      (r.cancelValue ? `  取消可（checkCancel=${r.cancelValue}）` : "  取消不可（期限切れ）"),
  );
}

if (!process.argv.includes("--select")) {
  console.log(
    "\n取消確認画面まで進むには --select を付けてください（確定は送りません）",
  );
  process.exit(0);
}

const cancellable = parsed.find((r) => r.cancelValue);
if (!cancellable) {
  console.log("\n取消可能な予約がないため、取消確認画面は調査できません");
  process.exit(0);
}

console.log(`\n取消確認画面へ進みます（対象: ${cancellable.date} ${cancellable.timeRange}）`);
const confirmScreen = await client.postBack(formAction(reservations), "next", "", [
  ["checkCancel", cancellable.cancelValue!],
]);
await dump("予約取消確認", confirmScreen, "cancel-confirm");
console.log("\n※ 確定は送っていないため、予約は取り消されていない");
