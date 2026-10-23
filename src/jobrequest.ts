/**
 * webhook から予約 / 取消 Job への依頼（対象のコマ）の受け渡し。
 *
 * **環境変数の上書きでは渡さない**（`src/runjob.ts`）。webhook は Job を overrides なしで
 * 起動し、返ってきた Execution 名をキーに依頼を state に書く。Job は自分の
 * Execution 名（Cloud Run が CLOUD_RUN_EXECUTION として渡す）で依頼を読む。
 * 押すたびに Execution が分かれるので、続けて押しても依頼を取り違えない。
 *
 * webhook は「起動 → 書き込み」の順なので、Job の方が先に読みに来ることがある。
 * 現れるまで少し待つ。
 */
import type { StateStore } from "./state";

const JOB_REQUEST_PREFIX = "requests/";

/** Job が起動してから依頼が書かれるまで待つ上限。webhook は起動直後に書く。 */
const WAIT_TIMEOUT_MS = 60_000;
const WAIT_INTERVAL_MS = 2_000;

export interface JobRequest {
  slot: string;
}

interface WaitOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function jobRequestKey(execution: string): string {
  return `${JOB_REQUEST_PREFIX}${execution}.json`;
}

export async function writeJobRequest(
  state: StateStore,
  execution: string,
  request: JobRequest,
): Promise<void> {
  await state.write(jobRequestKey(execution), JSON.stringify(request));
}

/**
 * 依頼を外部入力として検証する。state のバケットは webhook も書けるため、
 * 中身を信用せず形を確かめる。コマとして実在するかは予約システム側の照合で決まる。
 */
function parseJobRequest(body: string, execution: string): JobRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`依頼を読めませんでした（${execution}）`);
  }
  const slot = (parsed as { slot?: unknown } | null)?.slot;
  if (typeof slot !== "string" || slot.trim() === "") {
    throw new Error(`依頼にコマがありません（${execution}）`);
  }
  return { slot: slot.trim() };
}

export async function readJobRequest(
  state: StateStore,
  execution: string,
  options: WaitOptions = {},
): Promise<JobRequest> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const deadline = now() + WAIT_TIMEOUT_MS;

  while (true) {
    const body = await state.read(jobRequestKey(execution));
    if (body) return parseJobRequest(body, execution);
    if (now() >= deadline) {
      throw new Error(`依頼が見つかりませんでした（${execution}）`);
    }
    await sleep(WAIT_INTERVAL_MS);
  }
}

/**
 * Job が扱うコマを決める。Cloud Run 上では Execution 名の依頼から、
 * ローカル実行では環境変数（`RESERVE_SLOT` / `CANCEL_SLOT`）から読む。
 */
export async function slotForJob(
  env: Record<string, string | undefined>,
  state: StateStore,
  localEnvName: string,
  options: WaitOptions = {},
): Promise<string> {
  const execution = env.CLOUD_RUN_EXECUTION?.trim();
  if (execution) return (await readJobRequest(state, execution, options)).slot;

  const slot = env[localEnvName]?.trim();
  if (!slot) throw new Error(`環境変数 ${localEnvName} が設定されていません`);
  return slot;
}
