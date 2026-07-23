import { ToshimaClient } from "./src/client";

const SOGO_TAIIKUJO = "116005";

const client = new ToshimaClient();
await client.openStartPage();
await client.openSportsCategory();

const daily = await client.selectFacility(SOGO_TAIIKUJO);
const tennis = daily.filter((e) => e.roomName.includes("庭球"));

console.log("=== 総合体育場 庭球場 日別空き状況 ===");
for (const entry of tennis) {
  console.log(`${entry.date}: ${entry.status}`);
}

const openDays = tennis.filter((e) => e.status === "○" || e.status === "△");
if (openDays.length === 0) {
  console.log("空きのある日はありません");
  process.exit(0);
}

const slots = await client.openTimeSlots(openDays.map((e) => e.checkdateValue));
console.log("\n=== 空きコマ ===");
for (const slot of slots) {
  console.log(`${slot.date} 第${Number(slot.courtNo)}面 ${slot.timeRange}`);
}
