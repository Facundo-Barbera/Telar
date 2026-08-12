/**
 * The panel's tab state.
 *
 * What matters is that the panel can be EMPTY — it opens with nothing selected
 * — and that closing a tab picks a neighbour rather than jumping focus across
 * the strip.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { closeOtherPanelTabs, closePanelTab, emptyPanelTabs, openPanelTab, type PanelTabState } from "./right-panel-tabs";
import { browserPanelTab, browserTabId, browserTabLabel, isPanelTab } from "@/components/right-panel";

type Tab = "agents" | "changes" | "usage" | `browser:${string}`;
const state = (tabs: Tab[], activeTab?: Tab, open = true): PanelTabState<Tab> => ({ tabs, ...(activeTab ? { activeTab } : {}), open });

describe("emptyPanelTabs", () => {
  test("starts closed with nothing selected", () => {
    // The whole point: arriving at a session must not decide what you look at.
    expect(emptyPanelTabs<Tab>()).toEqual({ tabs: [], open: false });
  });
});

describe("openPanelTab", () => {
  test("opens the panel and selects the tab", () => {
    expect(openPanelTab(emptyPanelTabs<Tab>(), "changes")).toEqual({ tabs: ["changes"], activeTab: "changes", open: true });
  });

  test("a tab is a singleton by kind — reopening focuses rather than duplicates", () => {
    const opened = openPanelTab(openPanelTab(emptyPanelTabs<Tab>(), "agents"), "changes");
    const again = openPanelTab(opened, "agents");
    expect(again.tabs).toEqual(["agents", "changes"]);
    expect(again.activeTab).toBe("agents");
  });

  test("reopens the panel when it was closed but still holds tabs", () => {
    expect(openPanelTab(state(["agents"], "agents", false), "agents").open).toBe(true);
  });
});

describe("closePanelTab", () => {
  test("focus moves to the tab on the right", () => {
    const next = closePanelTab(state(["agents", "changes", "usage"], "changes"), "changes");
    expect(next.tabs).toEqual(["agents", "usage"]);
    expect(next.activeTab).toBe("usage");
  });

  test("closing the rightmost tab falls back to the new last one", () => {
    const next = closePanelTab(state(["agents", "changes"], "changes"), "changes");
    expect(next.activeTab).toBe("agents");
  });

  test("closing an inactive tab does not steal focus", () => {
    const next = closePanelTab(state(["agents", "changes", "usage"], "usage"), "agents");
    expect(next.activeTab).toBe("usage");
  });

  test("closing the last tab leaves the panel open on its empty state", () => {
    // Open with no tabs is the "choose a surface" screen — not the same as shut.
    const next = closePanelTab(state(["agents"], "agents"), "agents");
    expect(next).toEqual({ tabs: [], open: true });
  });

  test("closing a tab that is not open changes nothing", () => {
    const before = state(["agents"], "agents");
    expect(closePanelTab(before, "usage")).toBe(before);
  });
});

describe("closeOtherPanelTabs", () => {
  test("keeps only the named tab, and focuses it", () => {
    expect(closeOtherPanelTabs(state(["agents", "changes", "usage"], "agents"), "changes")).toEqual({
      tabs: ["changes"],
      activeTab: "changes",
      open: true,
    });
  });

  test("is a no-op for a tab that is not open", () => {
    const before = state(["agents"], "agents");
    expect(closeOtherPanelTabs(before, "usage")).toBe(before);
  });
});

describe("browser pages are their own tabs", () => {
  test("a page id round-trips through its panel tab id", () => {
    const tab = browserPanelTab("tab_7");
    expect(tab).toBe("browser:tab_7");
    expect(browserTabId(tab)).toBe("tab_7");
  });

  test("a fixed surface reports no page id", () => {
    expect(browserTabId("agents")).toBeUndefined();
  });

  test("two pages are two independent tabs", () => {
    // The whole point of the change: opening a second page must not replace the
    // first, and closing one must leave the other alone.
    const one = openPanelTab(emptyPanelTabs<Tab>(), browserPanelTab("a"));
    const two = openPanelTab(one, browserPanelTab("b"));
    expect(two.tabs).toEqual(["browser:a", "browser:b"]);
    expect(closePanelTab(two, browserPanelTab("a")).tabs).toEqual(["browser:b"]);
  });

  test("a stored browser tab survives a reload even for a page that has since closed", () => {
    // `isPanelTab` answers a question about SHAPE, so a page the engine no
    // longer reports is still a tab you opened — the surface says it is gone
    // rather than the tab silently vanishing on restore.
    expect(isPanelTab("browser:whatever")).toBe(true);
    expect(isPanelTab("agents")).toBe(true);
    expect(isPanelTab("looms")).toBe(false);
  });
});

describe("browserTabLabel", () => {
  test("prefers the title", () => {
    expect(browserTabLabel({ title: "Management", url: "http://127.0.0.1:8317/management.html" })).toBe("Management");
  });

  test("falls back to the host, not the whole URL", () => {
    // Two tabs on the same site would otherwise be indistinguishable at the
    // width a tab actually has.
    expect(browserTabLabel({ title: "", url: "http://100.72.141.10:8317/management.html" })).toBe("100.72.141.10:8317");
  });

  test("falls back to the raw string when the URL will not parse", () => {
    expect(browserTabLabel({ title: "", url: "about:blank" })).toBe("about:blank");
    expect(browserTabLabel({ title: "", url: "" })).toBe("Untitled page");
  });
});
