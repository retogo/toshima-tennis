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

/** 予約するコマを環境変数の上書きとして渡し、Job を 1 回実行する。 */
export async function runReserveJob(
  target: JobTarget,
  slot: string,
  options: RunOptions = {},
): Promise<void> {
  const fetchFn = options.fetchFn ?? fetch;
  const token = await (options.getToken ?? tokenFromMetadataServer)();

  const url = `${RUN_API}/projects/${target.project}/locations/${target.region}/jobs/${target.job}:run`;
  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      overrides: {
        containerOverrides: [{ env: [{ name: "RESERVE_SLOT", value: slot }] }],
      },
    }),
  });

  if (response.ok) return;

  const detail = (await response.text()).replaceAll(token, "<token>");
  throw new Error(
    `Cloud Run Job の起動に失敗しました（${response.status}）: ${detail}`,
  );
}
