/**
 * LINE から変えられる設定の上書き。
 *
 * `reserve.json` はコンテナイメージに焼き込まれているので、変えるには再デプロイが
 * 必要になる。よく変えたい項目（動作モード・月の上限・希望する曜日と時間帯）は
 * GCS に上書きを置き、poll が `reserve.json` に重ねて読む。
 *
 * **ここは外部境界。** postback は署名と userId を検証済みだが、値そのものは
 * 利用者の操作で決まる。特に月の上限は支出の上限なので、選べる範囲の外は落とす。
 *
 * 壊れた内容で例外にしない。poll が起動しなくなると通知も予約も止まるため、
 * 読めない上書きは無視して `reserve.json` の値に落ちる。
 */
import type { ReserveConfig, ReserveMode } from "./config";

/** 上書きの置き場 */
export const SETTINGS_KEY = "settings.json";

/** サイトにある時間帯の枠（時間帯別空き状況の見出しと一致）。 */
export const TIME_RANGES = [
  "9:00～11:00",
  "11:00～13:00",
  "13:00～15:00",
  "15:00～17:00",
  "17:00～19:00",
  "19:00～21:00",
] as const;

/**
 * LINE から選べる月の上限。**そのまま支出の上限になる**（1 件 2,000 円）。
 * 誤タップで大きな値にできないよう、選択肢を絞って範囲外は受け付けない。
 */
export const MAX_PER_MONTH_CHOICES = [1, 2, 3, 4] as const;

const MODES: ReserveMode[] = ["approve", "auto"];

export interface RuntimeSettings {
  mode?: ReserveMode;
  maxPerMonth?: number;
  /** 0（日）〜6（土）。**空配列は「何も選んでいない」**で、何にも一致しない */
  daysOfWeek?: number[];
  /** TIME_RANGES のいずれか。空配列は同上 */
  timeRanges?: string[];
}

function pickMode(value: unknown): ReserveMode | undefined {
  return MODES.includes(value as ReserveMode) ? (value as ReserveMode) : undefined;
}

function pickMaxPerMonth(value: unknown): number | undefined {
  return MAX_PER_MONTH_CHOICES.includes(value as (typeof MAX_PER_MONTH_CHOICES)[number])
    ? (value as number)
    : undefined;
}

function pickDaysOfWeek(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const valid = value.every(
    (d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6,
  );
  return valid ? (value as number[]) : undefined;
}

function pickTimeRanges(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const valid = value.every((r) => TIME_RANGES.includes(r as (typeof TIME_RANGES)[number]));
  return valid ? (value as string[]) : undefined;
}

export function parseSettings(text: string): RuntimeSettings {
  if (text.trim() === "") return {};

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }

  const settings: RuntimeSettings = {};
  const mode = pickMode(raw.mode);
  if (mode) settings.mode = mode;
  const maxPerMonth = pickMaxPerMonth(raw.maxPerMonth);
  if (maxPerMonth) settings.maxPerMonth = maxPerMonth;
  const daysOfWeek = pickDaysOfWeek(raw.daysOfWeek);
  if (daysOfWeek) settings.daysOfWeek = daysOfWeek;
  const timeRanges = pickTimeRanges(raw.timeRanges);
  if (timeRanges) settings.timeRanges = timeRanges;
  return settings;
}

export function serializeSettings(settings: RuntimeSettings): string {
  return JSON.stringify(settings, null, 2);
}

/**
 * `reserve.json` に上書きを重ねる。
 *
 * **曜日と時間帯は 1 つの希望条件にまとめる。** LINE から編集できるのは
 * 「曜日の集合 × 時間帯の集合」1 組だけなので、複数の希望条件を持っていた場合は
 * この 1 組に置き換わる。指定していない側は元の条件を引き継ぐ。
 */
export function applySettings(
  config: ReserveConfig,
  settings: RuntimeSettings,
): ReserveConfig {
  const first = config.wishlist.wishes[0] ?? {};
  const editsWish =
    settings.daysOfWeek !== undefined || settings.timeRanges !== undefined;

  return {
    ...config,
    mode: settings.mode ?? config.mode,
    wishlist: {
      ...config.wishlist,
      maxPerMonth: settings.maxPerMonth ?? config.wishlist.maxPerMonth,
      wishes: editsWish
        ? [
            {
              ...(settings.daysOfWeek ?? first.daysOfWeek
                ? { daysOfWeek: settings.daysOfWeek ?? first.daysOfWeek }
                : {}),
              ...(settings.timeRanges ?? first.timeRanges
                ? { timeRanges: settings.timeRanges ?? first.timeRanges }
                : {}),
            },
          ]
        : config.wishlist.wishes,
    },
  };
}

/** 曜日を入れ替える。日曜から土曜の順に保つ。 */
export function toggleDay(days: number[], day: number): number[] {
  const next = days.includes(day)
    ? days.filter((d) => d !== day)
    : [...days, day];
  return next.sort((a, b) => a - b);
}

/**
 * 時間帯を入れ替える。並びは TIME_RANGES の順（＝時間の早い順）に保つ。
 * 文字列順に並べると時が 1 桁のときに "15:00" が "9:00" より前に来る。
 */
export function toggleTimeRange(ranges: string[], range: string): string[] {
  if (!TIME_RANGES.includes(range as (typeof TIME_RANGES)[number])) return ranges;
  const next = ranges.includes(range)
    ? ranges.filter((r) => r !== range)
    : [...ranges, range];
  return TIME_RANGES.filter((r) => next.includes(r));
}
