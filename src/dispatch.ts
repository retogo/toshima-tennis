/**
 * postback で受け取った予約指示を実行に回す。
 *
 * **HTTP レスポンスを返す前に await し切ること。** webhook の Cloud Run は
 * cpu_idle = true（リクエスト処理中だけ CPU を割り当てる）で動かしているため、
 * 200 を返した後に投げっぱなしにした処理には CPU が割り当てられず、Job が
 * 起動しないまま終わる。実際にボタンを押しても reserve Job が一度も実行されず、
 * webhook のログにも成否が残らないという状態になっていた。
 *
 * 待っても遅くならない。ここでやるのは Job の起動（HTTP 1 回）と応答（同 1 回）
 * だけで、予約そのものは Cloud Run Job 側で走る。
 *
 * LINE には常に 200 を返す必要があるため、この関数は例外を投げない。
 * 失敗はログと LINE への応答で伝える。
 */
import { replyMessage } from "./line";
import { runReserveJob, type JobTarget } from "./runjob";
import type { ReserveCommand } from "./webhook";

export interface DispatchContext {
  jobTarget: JobTarget;
  channelAccessToken: string;
}

export interface DispatchOptions {
  fetchFn?: typeof fetch;
  getToken?: () => Promise<string>;
}

export async function dispatchReserveCommands(
  commands: ReserveCommand[],
  context: DispatchContext,
  options: DispatchOptions = {},
): Promise<void> {
  for (const { slot, replyToken } of commands) {
    let text: string;
    try {
      await runReserveJob(context.jobTarget, slot, options);
      console.log(`予約を起動しました: ${slot}`);
      text = `予約処理を開始しました。\n${slot}\n\n結果は改めて通知します。`;
    } catch (e) {
      console.error("予約の起動に失敗:", (e as Error).message);
      text = `予約の起動に失敗しました。\n${(e as Error).message}`;
    }

    if (!replyToken) continue;

    // 応答が届かなくても予約自体は進む。ここで止めない。
    await replyMessage(
      context.channelAccessToken,
      replyToken,
      text,
      options.fetchFn,
    ).catch((e) => console.error("応答の送信に失敗:", (e as Error).message));
  }
}
