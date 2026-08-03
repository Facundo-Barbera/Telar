// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ACTIVITY_TAB,
  DEFAULT_RIGHT_PANEL_SESSION,
  EMPTY_RIGHT_PANEL_PAYLOAD,
  RIGHT_PANEL_SCHEMA_VERSION,
  RIGHT_PANEL_SESSION_CAP,
  boundRightPanelSessions,
  closeOtherPanelTabs,
  closePanelTab,
  closePanelTabsToRight,
  parseRightPanelPayload,
  sanitizeRightPanelPayload,
  setPanelSession,
  type BrowserPanelTab,
  type RightPanelSession,
} from "@/lib/right-panel-store";

const browser = (id: string): BrowserPanelTab => ({
  id,
  kind: "browser",
  title: id,
  url: `https://${id}.example`,
});

const state = (ids: string[], activeTabId = ids[0] ?? null): RightPanelSession => ({
  tabs: ids.map(browser),
  activeTabId,
  open: true,
  fullscreen: false,
  touchedAt: 1,
});

describe("right panel persistence", () => {
  test("corrupt, absent, and unknown schema versions reset safely", () => {
    expect(parseRightPanelPayload(null)).toBe(EMPTY_RIGHT_PANEL_PAYLOAD);
    expect(parseRightPanelPayload("not json")).toBe(EMPTY_RIGHT_PANEL_PAYLOAD);
    expect(sanitizeRightPanelPayload({ version: 999, sessions: {} })).toBe(
      EMPTY_RIGHT_PANEL_PAYLOAD,
    );
  });

  test("sanitizes tabs, active id, and legacy missing fields", () => {
    const parsed = sanitizeRightPanelPayload({
      version: RIGHT_PANEL_SCHEMA_VERSION,
      sessions: {
        one: {
          tabs: [browser("a"), browser("a"), { id: "bad", kind: "nope" }],
          activeTabId: "missing",
        },
      },
    });
    expect(parsed.sessions.one).toEqual({
      tabs: [browser("a")],
      activeTabId: null,
      open: false,
      fullscreen: false,
      touchedAt: 0,
    });
  });

  test("keeps a stable default without materializing untouched sessions", () => {
    expect(DEFAULT_RIGHT_PANEL_SESSION.tabs).toEqual([]);
    expect(DEFAULT_RIGHT_PANEL_SESSION.activeTabId).toBeNull();
    expect(DEFAULT_RIGHT_PANEL_SESSION.open).toBe(false);
    expect(DEFAULT_RIGHT_PANEL_SESSION.fullscreen).toBe(false);
    expect(EMPTY_RIGHT_PANEL_PAYLOAD.sessions).toEqual({});
  });

  test("migrates old panel state to the closed-by-default dock once", () => {
    for (const version of [1, 2]) {
      const parsed = sanitizeRightPanelPayload({
        version,
        sessions: {
          legacy: { ...state(["browser"]), open: true },
        },
      });
      expect(parsed.version).toBe(RIGHT_PANEL_SCHEMA_VERSION);
      expect(parsed.sessions.legacy.open).toBe(false);
      expect(parsed.sessions.legacy.fullscreen).toBe(false);
    }
  });

  test("preserves version 3 open state while adding fullscreen state", () => {
    const parsed = sanitizeRightPanelPayload({
      version: 3,
      sessions: {
        existing: {
          ...state(["browser"]),
          tabs: [DEFAULT_ACTIVITY_TAB, browser("browser")],
          activeTabId: "browser",
          open: true,
        },
      },
    });
    expect(parsed.sessions.existing.open).toBe(true);
    expect(parsed.sessions.existing.fullscreen).toBe(false);
    expect(parsed.sessions.existing.tabs).toEqual([browser("browser")]);
    expect(parsed.sessions.existing.activeTabId).toBe("browser");
  });

  test("migrates the old injected Activity selection to the surface chooser", () => {
    const parsed = sanitizeRightPanelPayload({
      version: 4,
      sessions: {
        existing: {
          ...state([]),
          tabs: [DEFAULT_ACTIVITY_TAB, browser("browser")],
          activeTabId: "activity",
          open: true,
        },
      },
    });
    expect(parsed.sessions.existing).toMatchObject({
      tabs: [browser("browser")],
      activeTabId: null,
      open: true,
    });
  });
});

describe("deterministic bounded eviction", () => {
  test("pins the cap at 24 sessions", () => {
    expect(RIGHT_PANEL_SESSION_CAP).toBe(24);
  });

  test("evicts oldest touches and breaks ties by lexical session key", () => {
    const sessions = Object.fromEntries(
      Array.from({ length: 26 }, (_, index) => [
        `s-${String(index).padStart(2, "0")}`,
        { ...state([`t-${index}`]), touchedAt: index < 2 ? 1 : index },
      ]),
    );
    const bounded = boundRightPanelSessions({ version: RIGHT_PANEL_SCHEMA_VERSION, sessions });
    expect(Object.keys(bounded.sessions)).toHaveLength(24);
    expect(bounded.sessions["s-00"]).toBeUndefined();
    expect(bounded.sessions["s-01"]).toBeUndefined();
  });

  test("updating an old session makes it survive the next eviction", () => {
    let payload = EMPTY_RIGHT_PANEL_PAYLOAD;
    for (let i = 0; i < RIGHT_PANEL_SESSION_CAP; i++) {
      payload = setPanelSession(payload, `s-${i}`, state([`t-${i}`]), i);
    }
    payload = setPanelSession(payload, "s-0", state(["new"]), 100);
    payload = setPanelSession(payload, "overflow", state(["last"]), 101);
    expect(payload.sessions["s-0"]).toBeDefined();
    expect(payload.sessions["s-1"]).toBeUndefined();
  });
});

describe("tab closing", () => {
  test("closing the active tab selects right neighbor, then left neighbor", () => {
    const right = closePanelTab(state(["a", "b", "c"], "b"), "b");
    expect(right.activeTabId).toBe("c");
    const left = closePanelTab(state(["a", "b"], "b"), "b");
    expect(left.activeTabId).toBe("a");
  });

  test("closing the last surface returns to the chooser", () => {
    expect(closePanelTab(state(["a"], "a"), "a")).toMatchObject({
      tabs: [],
      activeTabId: null,
    });
    const activity: RightPanelSession = {
      ...state([]),
      tabs: [DEFAULT_ACTIVITY_TAB],
      activeTabId: "activity",
    };
    expect(closePanelTab(activity, "activity")).toMatchObject({
      tabs: [],
      activeTabId: null,
    });
  });

  test("close others and close right make the target deterministic", () => {
    expect(closeOtherPanelTabs(state(["a", "b", "c"], "a"), "b")).toMatchObject({
      tabs: [browser("b")],
      activeTabId: "b",
    });
    expect(closePanelTabsToRight(state(["a", "b", "c"], "c"), "b")).toMatchObject({
      tabs: [browser("a"), browser("b")],
      activeTabId: "b",
    });
  });
});
