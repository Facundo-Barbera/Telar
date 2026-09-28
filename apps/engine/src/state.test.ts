import { expect, test } from "bun:test";
import { useTempStores } from "../test/temp-store";

const { readyStore } = useTempStores();

test("the live-session read carries the arrangement, so a drag on one device reaches the others", () => {
  // THE PROPAGATION PATH. Every rail — the desktop shell, a browser tab, the
  // phone — polls this one route on its own cadence already; carrying the
  // layout on it is what lets a second device learn about a drop without a new
  // request, a new timer or a new connection. A blank document rides along too:
  // "nobody has arranged anything" is an answer, and a client that got no key
  // could not tell it from an engine too old to have one.
  const { store } = readyStore();
  expect(store.liveSessions().layout).toEqual({ projectOrder: [], sessionOrder: {}, pinnedOrder: [], mode: "grouped" });

  store.settings.setSidebarLayout({ projectOrder: ["p2", "p1"] });
  store.settings.setSidebarLayout({ sessionOrder: { p1: ["s2", "s1"] } });
  store.settings.setSidebarLayout({ pinnedOrder: ["s9"] });
  expect(store.liveSessions().layout).toEqual({
    projectOrder: ["p2", "p1"],
    sessionOrder: { p1: ["s2", "s1"] },
    pinnedOrder: ["s9"],
    mode: "grouped",
  });
});
