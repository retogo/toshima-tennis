/**
 * リッチメニューを作って登録する（ローカル実行専用）。
 *
 * リッチメニューは「メニューの絵が描かれた画像 1 枚」＋「その上に重ねる透明な
 * タップ領域」という作り。文字だけのリッチメニューは作れないので、見た目は
 * `scripts/richmenu.html` に描き、それをヘッドレス Chrome で PNG にする。
 *
 * ヘッドレスにするのは、画面の解像度に縛られず**指定した px で正確に**出力する
 * ため。ブラウザを操作して撮ると viewport とデバイスピクセル比に左右される。
 *
 * サイズの制約（すべて richmenu/validate で実測）:
 *   幅 800〜2500 / 高さ 250 以上 / 幅÷高さ ≥ 1.45 / タップ領域は最大 20
 *
 * 実行:
 *   bun run richmenu           # 画像を作って検証するだけ（登録しない）
 *   bun run richmenu --upload  # 作成・画像アップロードまで（まだ表示されない）
 *   bun run richmenu --apply   # 既定として適用する（ここで利用者に見えるようになる）
 */
import { TERMS } from "../src/line";

const OUT_DIR = process.env.RICHMENU_OUT_DIR ?? ".richmenu";
const IMAGE_PATH = `${OUT_DIR}/richmenu.png`;
const HTML_PATH = "scripts/richmenu.html";

/** 横 3 分割。richmenu.html の grid-template-columns と必ず揃える。 */
const WIDTH = 2500;
const HEIGHT = 843;
const COLUMNS = 3;

const CHROME =
  process.env.CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`環境変数 ${name} が設定されていません`);
  return value;
}

const token = required("LINE_CHANNEL_ACCESS_TOKEN");

/** 各列に割り当てる操作。押すと用語が送信され、会話に残る。 */
const CELLS: { label: string; text: string }[] = [
  { label: "予約状況", text: TERMS.status },
  { label: "自動で予約", text: TERMS.auto },
  { label: "押したら予約", text: TERMS.approve },
];

if (CELLS.length !== COLUMNS) {
  throw new Error(`列数（${COLUMNS}）と操作の数（${CELLS.length}）が合いません`);
}

/** 画像の列と同じ位置に透明なタップ領域を置く。 */
function buildRichMenu() {
  const columnWidth = Math.floor(WIDTH / COLUMNS);
  return {
    size: { width: WIDTH, height: HEIGHT },
    // true にすると友だち追加時に開いた状態になる。閉じた状態から始めたいので false
    selected: false,
    name: "toshima-tennis",
    chatBarText: TERMS.menu,
    areas: CELLS.map((cell, index) => ({
      bounds: {
        x: columnWidth * index,
        y: 0,
        // 端の丸め誤差で最後の列に隙間ができないように、最終列は残り全部を取る
        width: index === COLUMNS - 1 ? WIDTH - columnWidth * index : columnWidth,
        height: HEIGHT,
      },
      action: { type: "message", label: cell.label, text: cell.text },
    })),
  };
}

async function api(
  url: string,
  init: RequestInit & { headers?: Record<string, string> },
): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
  });
  if (!response.ok) {
    // 例外にアクセストークンを載せない
    const detail = (await response.text()).replaceAll(token, "<token>");
    throw new Error(`${url} が失敗しました（${response.status}）: ${detail}`);
  }
  return response;
}

// --- 1. 画像を作る ---
// Chrome は出力先のディレクトリを作らないので先に用意する
await Bun.$`mkdir -p ${OUT_DIR}`.quiet();

const html = Bun.pathToFileURL(HTML_PATH).href;
const chrome = Bun.spawnSync([
  CHROME,
  "--headless",
  "--disable-gpu",
  "--hide-scrollbars",
  `--screenshot=${IMAGE_PATH}`,
  `--window-size=${WIDTH},${HEIGHT}`,
  "--force-device-scale-factor=1",
  html,
]);
if (!(await Bun.file(IMAGE_PATH).exists())) {
  throw new Error(
    `画像を作れませんでした: ${new TextDecoder().decode(chrome.stderr).slice(0, 400)}`,
  );
}

const bytes = (await Bun.file(IMAGE_PATH).arrayBuffer()).byteLength;
console.log(`画像: ${IMAGE_PATH}（${(bytes / 1024).toFixed(0)} KB）`);

// --- 2. 定義を検証する（通数も何も消費しない） ---
const richMenu = buildRichMenu();
await api("https://api.line.me/v2/bot/richmenu/validate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(richMenu),
});
console.log("定義の検証: OK");
for (const area of richMenu.areas) {
  console.log(
    `  x=${area.bounds.x} 幅=${area.bounds.width} → 「${area.action.text}」送信`,
  );
}

if (!process.argv.includes("--upload") && !process.argv.includes("--apply")) {
  console.log("\n登録するには --upload、利用者に見せるには --apply を付けてください");
  process.exit(0);
}

// --- 3. 作成して画像を載せる（この時点ではまだ表示されない） ---
const created = await api("https://api.line.me/v2/bot/richmenu", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(richMenu),
});
const { richMenuId } = (await created.json()) as { richMenuId: string };
console.log(`作成しました: ${richMenuId}`);

// 画像のアップロードだけ api-data.line.me 側
await api(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
  method: "POST",
  headers: { "Content-Type": "image/png" },
  body: await Bun.file(IMAGE_PATH).arrayBuffer(),
});
console.log("画像をアップロードしました");

if (!process.argv.includes("--apply")) {
  console.log(
    "\n既定として適用するには --apply を付けてください（まだ利用者には見えていません）",
  );
  process.exit(0);
}

// --- 4. 既定として適用する（ここで見えるようになる） ---
await api(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {
  method: "POST",
});
console.log("既定のリッチメニューとして適用しました");
