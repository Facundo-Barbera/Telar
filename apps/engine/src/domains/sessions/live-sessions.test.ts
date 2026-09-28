import { expect, test } from "bun:test";
import { useTempStores } from "../../../test/temp-store";

const { readyStore } = useTempStores();

test("the live-session read carries the arrangement, so a drag on one device reaches the others", () => {
  // Every rail already polls this route, so the layout riding it reaches other devices with no new request.
  const { store } = readyStore();
  expect(store.live.all().layout).toEqual({ projectOrder: [], sessionOrder: {}, pinnedOrder: [], mode: "grouped" });

  store.settings.setSidebarLayout({ projectOrder: ["p2", "p1"] });
  store.settings.setSidebarLayout({ sessionOrder: { p1: ["s2", "s1"] } });
  store.settings.setSidebarLayout({ pinnedOrder: ["s9"] });
  expect(store.live.all().layout).toEqual({
    projectOrder: ["p2", "p1"],
    sessionOrder: { p1: ["s2", "s1"] },
    pinnedOrder: ["s9"],
    mode: "grouped",
  });
});
