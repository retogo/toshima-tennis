/**
 * postback で受け取った指示（予約 / 承認 / 取消）を実行に回す。
 *
 * **HTTP レスポンスを返す前に await し切ること。** webhook の Cloud Run は
 * cpu_idle = true（リクエスト処理中だけ CPU を割り当てる）で動かしているため、
 * 200 を返した後に投げっぱなしにした処理には CPU が割り当てられず、Job が
 * 起動しないまま終わる。実際にボタンを押しても reserve Job が一度も実行されず、
 * webhook のログにも成否が残らないという状態になっていた。
 *
 * 予約と取消は Cloud Run Job に投げる（webhook は予約システムの認証情報を
 * 持たない）。承認は予約システムに触らないので、ここで状態を書き換えるだけ。
 *
 * LINE には常に 200 を返す必要があるため、この関数は例外を投げない。
 * 失敗はログと LINE への応答で伝える。
 */
import {
  buildMenuMessage,
  buildStatusMessage,
  replyMessages as reply,
  type StatusRow,
} from "./line";
import { runJob, type JobTarget } from "./runjob";
import {
  MODE_KEY,
  SNAPSHOT_KEY,
  formatStatus,
  parseModeOverride,
  parseSnapshot,
} from "./runtime";
import { DEFAULT_CANCEL_BUFFER_DAYS, type ReserveMode } from "./config";
import type { StateStore } from "./state";
import { approveTracked, parseTracked, serializeTracked } from "./tracked";
import type { Command } from "./webhook";

/** 承認状態の置き場（poll / cancel Job と共有する） */
export const TRACKED_KEY = "tracked.json";

export interface DispatchContext {
  /** 予約 Job */
  jobTarget: JobTarget;
  /** 取消 Job の名前（プロジェクト・リージョンは jobTarget と同じ） */
  cancelJob: string;
  channelAccessToken: string;
}

export interface DispatchOptions {
  fetchFn?: typeof fetch;
  getToken?: () => Promise<string>;
  state?: StateStore;
}

/** 指示ごとに、起動する Job と渡す環境変数を決める。 */
function jobFor(
  command: Command,
  context: DispatchContext,
): { job: string; env: { name: string; value: string } } | undefined {
  if (command.action === "reserve") {
    return {
      job: context.jobTarget.job,
      env: { name: "RESERVE_SLOT", value: command.slot },
    };
  }
  if (command.action === "cancel") {
    return {
      job: context.cancelJob,
      env: { name: "CANCEL_SLOT", value: command.slot },
    };
  }
  return undefined; // approve は Job を起動しない
}

/** 承認を記録する。予約システムには触らない。 */
async function approve(
  slot: string,
  state: StateStore | undefined,
): Promise<string> {
  if (!state) throw new Error("承認の記録先が設定されていません");

  const tracked = parseTracked(await state.read(TRACKED_KEY));
  const updated = approveTracked(tracked, slot);
  if (updated === tracked) {
    return `${slot}\n\n自動予約の記録に見つかりませんでした。手動で取った予約は承認の対象外です。`;
  }

  await state.write(TRACKED_KEY, serializeTracked(updated));
  return `承認しました。\n${slot}\n\nこの予約は自動取消の対象から外れます。`;
}

/** 保存されているモード。無ければ既定（reserve.json 側の初期値と同じ）。 */
async function currentMode(state: StateStore): Promise<ReserveMode> {
  return parseModeOverride(await state.read(MODE_KEY)) ?? "notify";
}

/**
 * 動作モードを保存する。
 *
 * `reserve.json` はイメージに焼き込まれているため、ここで上書きを GCS に置き、
 * poll に読ませる。**auto は押した時点から実際に費用が動く**ので、応答で
 * 何が起きるかを明示する。
 */
async function switchMode(
  value: string,
  state: StateStore | undefined,
): Promise<string> {
  if (!state) throw new Error("モードの保存先が設定されていません");

  const mode = parseModeOverride(value);
  if (!mode) {
    return `不明なモードです（${value}）。notify / approve / auto のいずれかを選んでください。`;
  }

  await state.write(MODE_KEY, mode);

  const description: Record<ReserveMode, string> = {
    notify: "空きを通知するだけで、予約はしません。",
    approve: "候補をボタンで通知します。押すとその場で予約が確定します。",
    auto:
      "条件に合う空きを見つけたら自動で予約します。" +
      "予約後に承認しないと取消期限の前に自動で取り消します。" +
      "使用日が近く承認の猶予が取れないコマは自動で予約せず、ボタンで通知します。",
  };
  return `動作モードを ${mode} にしました。\n\n${description[mode]}`;
}

/**
 * 予約状況を返す。
 *
 * **webhook は予約システムの認証情報を持たない**ため、自分で一覧を取りに行かない。
 * poll が置いたスナップショットを読む。数分古くなるが、取消期限の判定は日付単位
 * なので実害がない。
 */
async function status(state: StateStore | undefined): Promise<{
  text: string;
  rows: StatusRow[];
}> {
  if (!state) throw new Error("状態の置き場が設定されていません");

  const snapshot = parseSnapshot(await state.read(SNAPSHOT_KEY));
  const tracked = parseTracked(await state.read(TRACKED_KEY));
  const mode = await currentMode(state);

  const text = formatStatus(
    {
      mode,
      reservations: snapshot?.reservations,
      tracked,
      cancelBufferDays: snapshot?.cancelBufferDays ?? DEFAULT_CANCEL_BUFFER_DAYS,
      ...(snapshot ? { takenAt: new Date(snapshot.takenAt) } : {}),
    },
    new Date(),
  );

  const rows: StatusRow[] = (snapshot?.reservations ?? []).map((reservation) => ({
    // 面はサイトが区別しないため、取消ボタンには第1面として載せる
    // （findReservation は利用日と時間帯で突き合わせる）
    slot: `${reservation.date} 第1面 ${reservation.timeRange}`,
    cancellable: reservation.cancelValue !== undefined,
  }));

  return { text, rows };
}

export async function dispatchCommands(
  commands: Command[],
  context: DispatchContext,
  options: DispatchOptions = {},
): Promise<void> {
  for (const command of commands) {
    // Flex を返す操作（メニュー・状況）はこちらに入れる
    let messages: unknown[] | undefined;
    let text: string | undefined;

    try {
      const target = jobFor(command, context);
      if (target) {
        await runJob(
          { ...context.jobTarget, job: target.job },
          [target.env],
          options,
        );
        console.log(`${command.action} を起動しました: ${command.slot}`);
        text =
          command.action === "reserve"
            ? `予約処理を開始しました。\n${command.slot}\n\n結果は改めて通知します。`
            : `取消処理を開始しました。\n${command.slot}\n\n結果は改めて通知します。`;
      } else if (command.action === "approve") {
        text = await approve(command.slot, options.state);
      } else if (command.action === "mode") {
        text = await switchMode(command.slot, options.state);
      } else if (command.action === "menu") {
        messages = [buildMenuMessage(await currentMode(options.state!))];
      } else {
        const { text: body, rows } = await status(options.state);
        messages = [buildStatusMessage(body, rows)];
      }
    } catch (e) {
      console.error(`${command.action} に失敗:`, (e as Error).message);
      text = `処理に失敗しました。\n${(e as Error).message}`;
    }

    if (!command.replyToken) continue;

    // 応答が届かなくても処理自体は進む。ここで止めない。
    await reply(
      context.channelAccessToken,
      command.replyToken,
      messages ?? [{ type: "text", text }],
      options.fetchFn,
    ).catch((e) => console.error("応答の送信に失敗:", (e as Error).message));
  }
}
