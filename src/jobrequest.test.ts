import { describe, expect, test } from "bun:test";
import {
  jobRequestKey,
  readJobRequest,
  slotForJob,
  writeJobRequest,
} from "./jobrequest";
import type { StateStore } from "./state";

const SLOT = "2026-08-24 第4面 9:00～11:00";
const EXECUTION = "toshima-reserve-ab12c";

function memoryStore(files = new Map<string, string>()): StateStore {
  return {
    async read(key) {
      return files.get(key) ?? "";
    },
    async write(key, value) {
      files.set(key, value);
    },
  };
}

/** 時計を進めるだけの sleep。待った回数を数える。 */
function fakeClock() {
  let now = 0;
  let sleeps = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
      sleeps += 1;
    },
    sleeps: () => sleeps,
  };
}

describe("jobRequestKey", () => {
  test("Execution 名ごとに別のキーにする", () => {
    expect(jobRequestKey(EXECUTION)).toBe(`requests/${EXECUTION}.json`);
  });
});

describe("readJobRequest", () => {
  test("書いた依頼を読める", async () => {
    const state = memoryStore();
    await writeJobRequest(state, EXECUTION, { slot: SLOT });

    expect(await readJobRequest(state, EXECUTION, fakeClock())).toEqual({ slot: SLOT });
  });

  test("依頼がまだ無ければ現れるまで待つ", async () => {
    // webhook は Job を起動してから依頼を書くので、Job の方が先に読みに来ることがある
    const files = new Map<string, string>();
    const clock = fakeClock();
    const state = memoryStore(files);
    const sleep = async (ms: number) => {
      await clock.sleep(ms);
      if (clock.sleeps() === 2) files.set(jobRequestKey(EXECUTION), JSON.stringify({ slot: SLOT }));
    };

    expect(await readJobRequest(state, EXECUTION, { ...clock, sleep })).toEqual({ slot: SLOT });
    expect(clock.sleeps()).toBe(2);
  });

  test("待っても現れなければ例外にする", async () => {
    await expect(readJobRequest(memoryStore(), EXECUTION, fakeClock())).rejects.toThrow(
      EXECUTION,
    );
  });

  test.each([
    ["JSON でない", "slot"],
    ["slot が無い", JSON.stringify({})],
    ["slot が文字列でない", JSON.stringify({ slot: 1 })],
    ["slot が空", JSON.stringify({ slot: " " })],
  ])("%s依頼は受け付けない", async (_, body) => {
    const state = memoryStore(new Map([[jobRequestKey(EXECUTION), body]]));
    await expect(readJobRequest(state, EXECUTION, fakeClock())).rejects.toThrow(/依頼/);
  });
});

describe("slotForJob", () => {
  test("Cloud Run 上では Execution 名の依頼からコマを読む", async () => {
    const state = memoryStore();
    await writeJobRequest(state, EXECUTION, { slot: SLOT });

    const env = { CLOUD_RUN_EXECUTION: EXECUTION, RESERVE_SLOT: "上書きは使わない" };
    expect(await slotForJob(env, state, "RESERVE_SLOT", fakeClock())).toBe(SLOT);
  });

  test("ローカル実行では環境変数からコマを読む", async () => {
    expect(await slotForJob({ RESERVE_SLOT: SLOT }, memoryStore(), "RESERVE_SLOT")).toBe(SLOT);
  });

  test("ローカル実行で環境変数が無ければ例外にする", async () => {
    await expect(slotForJob({}, memoryStore(), "RESERVE_SLOT")).rejects.toThrow(
      "RESERVE_SLOT",
    );
  });
});
