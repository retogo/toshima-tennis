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
  buildSettingsMessage,
  buildStatusMessage,
  replyMessages as reply,
  type SettingsView,
  type StatusRow,
} from "./line";
import { runJob, type JobTarget } from "./runjob";
import { SNAPSHOT_KEY, formatStatus, parseSnapshot } from "./runtime";
import {
  MAX_PER_MONTH_CHOICES,
  SETTINGS_KEY,
  parseSettings,
  serializeSettings,
  toggleDay,
  toggleTimeRange,
  type RuntimeSettings,
} from "./settings";
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
  /**
   * mode.txt が無いときに表示するモード。**poll と同じ既定値を渡すこと。**
   * ここを決め打ちにすると、poll は reserve.json の値で動いているのに
   * メニューは別のモードを表示する、という食い違いが起きる。
   */
  defaultMode: ReserveMode;
  /**
   * 上書きが無いときに出す希望条件。**poll と同じ既定を渡すこと。**
   * reserve.json から読む（イメージに同梱されている）。
   */
  defaultWishes: {
    maxPerMonth: number;
    daysOfWeek: number[];
    timeRanges: string[];
  };
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
    return `${slot}\n手動の予約なので承認は不要です。`;
  }

  await state.write(TRACKED_KEY, serializeTracked(updated));
  return `承認しました\n${slot}\n自動取消しません。`;
}

/** 保存されている上書きを読む。 */
async function loadSettings(state: StateStore): Promise<RuntimeSettings> {
  return parseSettings(await state.read(SETTINGS_KEY));
}

/** 保存されているモード。無ければ呼び出し側が渡した既定（reserve.json の値）。 */
async function currentMode(
  state: StateStore,
  defaultMode: ReserveMode,
): Promise<ReserveMode> {
  return (await loadSettings(state)).mode ?? defaultMode;
}

/**
 * 希望条件の編集画面を返す。
 *
 * 上書きが無い項目は `reserve.json` の値（呼び出し側が渡す既定）を出す。
 * 表示と保存で別の値を見ると、押した結果が画面と食い違う。
 */
async function settingsView(
  state: StateStore | undefined,
  defaults: DispatchContext["defaultWishes"],
): Promise<SettingsView> {
  if (!state) throw new Error("設定の保存先が設定されていません");

  const settings = await loadSettings(state);
  return {
    maxPerMonth: settings.maxPerMonth ?? defaults.maxPerMonth,
    daysOfWeek: settings.daysOfWeek ?? defaults.daysOfWeek,
    timeRanges: settings.timeRanges ?? defaults.timeRanges,
  };
}

/** 希望条件を 1 項目変えて保存し、更新後の画面を返す。 */
async function editSettings(
  command: Command,
  state: StateStore | undefined,
  defaults: DispatchContext["defaultWishes"],
): Promise<SettingsView> {
  if (!state) throw new Error("設定の保存先が設定されていません");

  const view = await settingsView(state, defaults);
  const settings = await loadSettings(state);

  if (command.action === "day") {
    settings.daysOfWeek = toggleDay(view.daysOfWeek, Number(command.slot));
  } else if (command.action === "time") {
    settings.timeRanges = toggleTimeRange(view.timeRanges, command.slot);
  } else {
    const wanted = Number(command.slot);
    // 支出の上限になるので、選べる値の外は受け付けない
    if (!MAX_PER_MONTH_CHOICES.includes(wanted as 1)) {
      throw new Error(`月の上限に指定できない値です（${command.slot}）`);
    }
    settings.maxPerMonth = wanted;
  }

  await state.write(SETTINGS_KEY, serializeSettings(settings));
  return settingsView(state, defaults);
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

  const mode = value === "auto" || value === "approve" ? value : undefined;
  if (!mode) return `不明なモードです（${value}）`;

  const settings = await loadSettings(state);
  await state.write(SETTINGS_KEY, serializeSettings({ ...settings, mode }));

  return mode === "auto"
    ? "自動で予約します。予約したら承認/取消のボタンを送ります。承認しないと期限前に取り消します。"
    : "空きが出たらボタンを送ります。押すと予約します。";
}

/**
 * 予約状況を返す。
 *
 * **webhook は予約システムの認証情報を持たない**ため、自分で一覧を取りに行かない。
 * poll が置いたスナップショットを読む。数分古くなるが、取消期限の判定は日付単位
 * なので実害がない。
 */
async function status(
  state: StateStore | undefined,
  defaultMode: ReserveMode,
): Promise<{
  text: string;
  rows: StatusRow[];
}> {
  if (!state) throw new Error("状態の置き場が設定されていません");

  const snapshot = parseSnapshot(await state.read(SNAPSHOT_KEY));
  const tracked = parseTracked(await state.read(TRACKED_KEY));
  const mode = await currentMode(state, defaultMode);

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
        text = `${command.action === "reserve" ? "予約" : "取消"}を開始しました\n${command.slot}\n結果はあとで送ります。`;
      } else if (command.action === "approve") {
        text = await approve(command.slot, options.state);
      } else if (command.action === "mode") {
        text = await switchMode(command.slot, options.state);
      } else if (command.action === "settings") {
        messages = [
          buildSettingsMessage(await settingsView(options.state, context.defaultWishes)),
        ];
      } else if (
        command.action === "day" ||
        command.action === "time" ||
        command.action === "max"
      ) {
        messages = [
          buildSettingsMessage(
            await editSettings(command, options.state, context.defaultWishes),
          ),
        ];
      } else if (command.action === "menu") {
        messages = [
          buildMenuMessage(await currentMode(options.state!, context.defaultMode)),
        ];
      } else {
        const { text: body, rows } = await status(options.state, context.defaultMode);
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
