/**
 * 自動予約の設定（reserve.json）の読み込み。
 *
 * 人が手で書くファイルであり、書き間違いがそのまま「意図しない予約」に
 * つながるため、ここは外部境界として厳しく検証する。
 * 特に上限（maxPerRun / maxPerMonth）が欠けた設定は受け付けない。
 */
import { MOKUTEKI, type ApplicationDetails, type Mokuteki } from "./client";
import type { Wish, Wishlist } from "./wishlist";

/**
 * 動作モード。
 *   notify  … 予約せず空き通知だけ（既定。事故を起こさない側に倒す）
 *   approve … 対象を見つけたら承認待ちにし、人間が承認して初めて予約する
 *   auto    … 対象を見つけたらその場で予約を確定する
 */
export type ReserveMode = "notify" | "approve" | "auto";

const MODES: ReserveMode[] = ["notify", "approve", "auto"];

export interface ReserveConfig {
  mode: ReserveMode;
  wishlist: Wishlist;
  application: ApplicationDetails;
}

function parseMode(value: unknown): ReserveMode {
  if (value === undefined) return "notify";
  if (typeof value !== "string" || !MODES.includes(value as ReserveMode)) {
    throw new Error(`mode には ${MODES.join(" / ")} のいずれかを指定してください`);
  }
  return value as ReserveMode;
}

const MOKUTEKI_NAMES = Object.keys(MOKUTEKI) as (keyof typeof MOKUTEKI)[];

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} はオブジェクトで指定してください`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} には 1 以上の整数を指定してください`);
  }
  return value;
}

function parseWish(value: unknown, index: number): Wish {
  const raw = asRecord(value, `wishes[${index}]`);
  const wish: Wish = {};

  if (raw.daysOfWeek !== undefined) {
    const days = raw.daysOfWeek;
    if (
      !Array.isArray(days) ||
      days.length === 0 ||
      !days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)
    ) {
      throw new Error(
        `wishes[${index}].daysOfWeek には 0（日）〜6（土）の配列を指定してください`,
      );
    }
    wish.daysOfWeek = days as number[];
  }

  if (raw.timeRanges !== undefined) {
    const ranges = raw.timeRanges;
    if (!Array.isArray(ranges) || ranges.some((r) => typeof r !== "string")) {
      throw new Error(
        `wishes[${index}].timeRanges には "9:00～11:00" 形式の文字列の配列を指定してください`,
      );
    }
    wish.timeRanges = ranges as string[];
  }

  if (raw.courts !== undefined) {
    const courts = raw.courts;
    if (!Array.isArray(courts) || courts.some((c) => !Number.isInteger(c))) {
      throw new Error(`wishes[${index}].courts には面番号の配列を指定してください`);
    }
    wish.courts = courts as number[];
  }

  return wish;
}

function parseMokuteki(value: unknown): Mokuteki {
  if (value === undefined) return MOKUTEKI.tennis;
  if (typeof value !== "string" || !(value in MOKUTEKI)) {
    throw new Error(
      `mokuteki には ${MOKUTEKI_NAMES.join(" / ")} のいずれかを指定してください`,
    );
  }
  return MOKUTEKI[value as keyof typeof MOKUTEKI];
}

export function parseConfig(json: string): ReserveConfig {
  let raw: Record<string, unknown>;
  try {
    raw = asRecord(JSON.parse(json), "設定");
  } catch (e) {
    throw new Error(`設定を JSON として読めませんでした: ${(e as Error).message}`);
  }

  if (!Array.isArray(raw.wishes) || raw.wishes.length === 0) {
    throw new Error("wishes には希望条件を 1 件以上指定してください");
  }

  return {
    mode: parseMode(raw.mode),
    wishlist: {
      wishes: raw.wishes.map(parseWish),
      maxPerMonth: positiveInteger(raw.maxPerMonth, "maxPerMonth"),
      maxPerRun: positiveInteger(raw.maxPerRun, "maxPerRun"),
    },
    application: {
      ninzu: positiveInteger(raw.ninzu, "ninzu"),
      mokuteki: parseMokuteki(raw.mokuteki),
      gyoujiMeishou:
        raw.gyoujiMeishou === undefined ? "テニス" : String(raw.gyoujiMeishou),
    },
  };
}
