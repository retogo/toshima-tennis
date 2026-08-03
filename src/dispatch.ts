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
import { replyMessage } from "./line";
import { runJob, type JobTarget } from "./runjob";
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

export async function dispatchCommands(
  commands: Command[],
  context: DispatchContext,
  options: DispatchOptions = {},
): Promise<void> {
  for (const command of commands) {
    let text: string;
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
      } else {
        text = await approve(command.slot, options.state);
      }
    } catch (e) {
      console.error(`${command.action} に失敗:`, (e as Error).message);
      text = `${command.action === "approve" ? "承認" : "起動"}に失敗しました。\n${(e as Error).message}`;
    }

    if (!command.replyToken) continue;

    // 応答が届かなくても処理自体は進む。ここで止めない。
    await replyMessage(
      context.channelAccessToken,
      command.replyToken,
      text,
      options.fetchFn,
    ).catch((e) => console.error("応答の送信に失敗:", (e as Error).message));
  }
}
