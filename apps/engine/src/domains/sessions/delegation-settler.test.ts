import { expect, test } from "bun:test";
import { useTempStores } from "../../../test/temp-store";

const { readyStore } = useTempStores();

test("the delegation sweep reads no queue of a settled or archived session", () => {
  const { store } = readyStore();
  store.settings.setInbox({ settleDelegatedAfterHours: 1 });
  for (let n = 0; n < 200; n += 1) {
    store.lifecycle.createSession({ id: `session_shelf_${n}`, projectId: "project_one" });
    if (n % 2 === 0) store.lifecycle.updateSession(`session_shelf_${n}`, { settledOverride: "settled" });
    else store.lifecycle.archiveSession(`session_shelf_${n}`);
  }
  const before = store.kernel.readAccounting.queueParses;
  expect(store.settler.sweepDelegated()).toEqual([]);
  expect(store.kernel.readAccounting.queueParses - before).toBeLessThanOrEqual(2);
});
