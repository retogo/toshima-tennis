/**
 * Cloud Run Job を起動する。
 *
 * LINE の webhook が予約を実行させるために使う。予約システムの認証情報は
 * Job 側（Secret Manager 経由）にあり、webhook は起動するだけで値を持たない。
 *
 * 認証は Cloud Run のメタデータサーバーから取るアクセストークンで行うため、
 * 長命の鍵を持たずに済む。
 */
const RUN_API = "https://run.googleapis.com/v2";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

export interface JobTarget {
  project: string;
  region: string;
  job: string;
}

interface RunOptions {
  fetchFn?: typeof fetch;
  getToken?: () => Promise<string>;
}

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

/**
 * Job を 1 回実行し、起動した Execution の名前を返す。
 *
 * **環境変数の上書き（overrides）は渡さない。** overrides を許す
 * `run.jobs.runWithOverrides` を webhook に持たせると、webhook が破られたとき
 * 任意の環境変数（`HTTPS_PROXY` など）を付けて予約システムの認証情報を持つ Job を
 * 動かせてしまう。対象のコマは Execution 名をキーにした依頼として state に置き
 * （`src/jobrequest.ts`）、起動は `roles/run.invoker` の `run.jobs.run` で足りるようにする。
 */
export async function runJob(
  target: JobTarget,
  options: RunOptions = {},
): Promise<string> {
  const fetchFn = options.fetchFn ?? fetch;
  const token = await (options.getToken ?? tokenFromMetadataServer)();

  const url = `${RUN_API}/projects/${target.project}/locations/${target.region}/jobs/${target.job}:run`;
  const response = await fetchFn(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const detail = (await response.text()).replaceAll(token, "<token>");
    throw new Error(
      `Cloud Run Job の起動に失敗しました（${response.status}）: ${detail}`,
    );
  }

  // 応答は Operation。metadata が起動した Execution で、name の末尾が Execution 名
  // （Job のコンテナには CLOUD_RUN_EXECUTION として渡る）。
  const operation = (await response.json()) as { metadata?: { name?: string } };
  const execution = operation.metadata?.name?.split("/").pop();
  if (!execution) {
    throw new Error("Cloud Run Job の起動結果に Execution の名前がありません");
  }
  return execution;
}
