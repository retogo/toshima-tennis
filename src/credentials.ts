/**
 * 予約に必要な認証情報の読み込み。
 *
 * このリポジトリは public なので、利用者番号・パスワードは決してコミットせず、
 * ローカルでは .env（gitignore 済み）、CI では GitHub secrets から環境変数として渡す。
 * 例外メッセージには値そのものを載せない（Actions のログに残るため）。
 */

/** ログインフォーム（txtUserID / txtPassWord）の maxlength に合わせる。 */
const MAX_LENGTH = 16;

export interface Credentials {
  userId: string;
  password: string;
}

function readRequired(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(
      `環境変数 ${name} が設定されていません。ローカルは .env、CI は GitHub secrets で渡してください`,
    );
  }
  if (value.length > MAX_LENGTH) {
    throw new Error(
      `環境変数 ${name} が長すぎます（サイトの上限は ${MAX_LENGTH} 文字、指定は ${value.length} 文字）`,
    );
  }
  return value;
}

export function loadCredentials(
  env: Record<string, string | undefined> = process.env,
): Credentials {
  return {
    userId: readRequired(env, "TOSHIMA_USER_ID"),
    password: readRequired(env, "TOSHIMA_PASSWORD"),
  };
}
