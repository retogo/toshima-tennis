/**
 * 通知の対象にするコマを決める。
 *
 * 空き通知は「前回から変化したら送る」エッジ検知だが、比較対象を全コマにすると
 * 希望していない曜日・時間帯の増減でも通知が鳴ってしまう。実測では空き 13 件が
 * すべて平日で、希望条件（土日）に一致するものは 0 件という状態が起きていた。
 *
 * そこで希望条件がある場合は、一致するコマだけを通知対象にする。
 */
import { compareChronologically, slotKey } from "./notify";
import { matchingSlots, type Wishlist } from "./wishlist";
import type { TimeSlot } from "./parser";

export function notifiableSlots(
  slots: TimeSlot[],
  wishlist: Wishlist | undefined,
  reserved: string[],
): TimeSlot[] {
  if (wishlist) return matchingSlots(slots, wishlist, reserved);

  const reservedKeys = new Set(reserved);
  return slots
    .filter((slot) => !reservedKeys.has(slotKey(slot)))
    .sort(compareChronologically);
}
