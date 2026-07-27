/**
 * LINE への疎通確認。テストメッセージを 1 通送るだけ。
 *
 *   bun run notify:test
 *   bun run notify:test "好きな本文"
 *
 * 認証情報は .env（ローカル）から読む。
 */
import { pushMessage } from "../src/line";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`環境変数 ${name} が設定されていません`);
  return value;
}

const text = process.argv[2] ?? "🎾 疎通確認";
await pushMessage(required("LINE_CHANNEL_ACCESS_TOKEN"), required("LINE_TO"), text);
console.log(`LINE に送信しました: ${text}`);
