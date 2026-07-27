/**
 * 実行をまたいで持ち回す状態（前回の空き状況・予約済みコマ）の置き場。
 *
 * Cloud Run Job はステートレスなので GCS に置く。ローカル実行では
 * ファイルシステムを使う。どちらも同じインターフェースで扱う。
 *
 * GCS へのアクセスは JSON API を fetch で直接叩く。Cloud Run 上では
 * メタデータサーバーからアクセストークンを取れるため、追加の依存を持たない。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface StateStore {
  /** 値を読む。存在しなければ空文字列。 */
  read(key: string): Promise<string>;
  write(key: string, value: string): Promise<void>;
}

export class LocalStateStore implements StateStore {
  constructor(private readonly dir: string) {}

  async read(key: string): Promise<string> {
    const path = join(this.dir, key);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  async write(key: string, value: string): Promise<void> {
    const path = join(this.dir, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  }
}

const API = "https://storage.googleapis.com/storage/v1";
const UPLOAD_API = "https://storage.googleapis.com/upload/storage/v1";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

interface GcsOptions {
  fetchFn?: typeof fetch;
  getToken?: () => Promise<string>;
}

/** Cloud Run のメタデータサーバーからアクセストークンを取る。 */
async function tokenFromMetadataServer(): Promise<string> {
  const response = await fetch(METADATA_TOKEN_URL, {
    headers: { "Metadata-Flavor": "Google" },
  });
  if (!response.ok) {
    throw new Error(
      `メタデータサーバーからトークンを取得できませんでした（${response.status}）`,
    );
  }
  const { access_token } = (await response.json()) as { access_token: string };
  return access_token;
}

export class GcsStateStore implements StateStore {
  private readonly fetchFn: typeof fetch;
  private readonly getToken: () => Promise<string>;

  constructor(
    private readonly bucket: string,
    options: GcsOptions = {},
  ) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.getToken = options.getToken ?? tokenFromMetadataServer;
  }

  async read(key: string): Promise<string> {
    const token = await this.getToken();
    const url = `${API}/b/${this.bucket}/o/${encodeURIComponent(key)}?alt=media`;
    const response = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    // 初回実行ではまだオブジェクトが無い
    if (response.status === 404) return "";
    if (!response.ok) throw await this.failure(response, token, "取得");

    return response.text();
  }

  async write(key: string, value: string): Promise<void> {
    const token = await this.getToken();
    const url = `${UPLOAD_API}/b/${this.bucket}/o?uploadType=media&name=${encodeURIComponent(key)}`;
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: value,
    });

    if (!response.ok) throw await this.failure(response, token, "書き込み");
  }

  private async failure(
    response: Response,
    token: string,
    what: string,
  ): Promise<Error> {
    const detail = (await response.text()).replaceAll(token, "<token>");
    return new Error(
      `GCS の${what}に失敗しました（${response.status}）: ${detail}`,
    );
  }
}

/**
 * 実行環境に応じた置き場を返す。
 * STATE_BUCKET があれば GCS、無ければローカルの .state を使う。
 */
export function stateStoreFromEnv(
  env: Record<string, string | undefined> = process.env,
): StateStore {
  const bucket = env.STATE_BUCKET?.trim();
  return bucket ? new GcsStateStore(bucket) : new LocalStateStore(".state");
}
