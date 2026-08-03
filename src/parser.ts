import { parse } from "node-html-parser";

export interface Facility {
  code: string;
  name: string;
}

export function extractToken(html: string): string {
  const root = parse(html);
  const input = root.querySelector('input[name="__RequestVerificationToken"]');
  if (!input) throw new Error("__RequestVerificationToken が見つかりません");
  return input.getAttribute("value")!;
}

/**
 * 画面の form action を取り出す。
 *
 * ログイン後の画面遷移は URL を決め打ちにできない（マイメニュー・予約一覧・
 * 取消確認で action が変わる）。今いる画面の form から次の POST 先を得る。
 */
export function extractFormAction(html: string): string {
  const action = parse(html).querySelector("form")?.getAttribute("action");
  if (!action) throw new Error("form の action が見つかりません");
  return action;
}

/** hidden 以外も含め、input の value を名前で取り出す。 */
export function extractInputValue(html: string, name: string): string {
  const input = parse(html).querySelector(`input[name="${name}"]`);
  return input?.getAttribute("value") ?? "";
}

export type DailyStatus = "○" | "△" | "×" | "－";

export interface DailyAvailability {
  roomCode: string;
  roomName: string;
  date: string;
  status: DailyStatus;
  checkdateValue: string;
}

export interface TimeSlot {
  roomCode: string;
  date: string;
  courtNo: string;
  timeRange: string;
  checktimeValue: string;
}

export function parseFacilities(html: string): Facility[] {
  const root = parse(html);
  return root
    .querySelectorAll('input[name="checkShisetsu"]')
    .map((input) => {
      const code = input.getAttribute("value")!;
      const label = root.querySelector(`label[for="checkShisetsu${code}"]`)!;
      return { code, name: label.text.trim() };
    });
}

export function parseDailyAvailability(html: string): DailyAvailability[] {
  const root = parse(html);
  const entries: DailyAvailability[] = [];
  for (const row of root.querySelectorAll("tr")) {
    const roomName = row.querySelector("td.shisetsu")?.text.trim();
    if (!roomName) continue;
    for (const input of row.querySelectorAll('input[name="checkdate"]')) {
      const value = input.getAttribute("value")!;
      const [, ymd, roomCode] = value.match(/^(\d{8})(\d{5})/)!;
      const id = input.getAttribute("id")!;
      const status = row
        .querySelector(`label[for="${id}"]`)!
        .text.trim() as DailyStatus;
      entries.push({
        roomCode: roomCode!,
        roomName,
        date: `${ymd!.slice(0, 4)}-${ymd!.slice(4, 6)}-${ymd!.slice(6, 8)}`,
        status,
        checkdateValue: value,
      });
    }
  }
  return entries;
}

export function parseTimeSlots(html: string): TimeSlot[] {
  const root = parse(html);
  return root.querySelectorAll('input[name="checktime"]').map((input) => {
    const value = input.getAttribute("value")!;
    const [, roomCode, ymd, courtNo, timeRange] = value.match(
      /^(\d{5})(\d{8})(\d{2})(.+)$/,
    )!;
    return {
      roomCode: roomCode!,
      date: `${ymd!.slice(0, 4)}-${ymd!.slice(4, 6)}-${ymd!.slice(6, 8)}`,
      courtNo: courtNo!,
      timeRange: timeRange!,
      checktimeValue: value,
    };
  });
}
