/**
 * `new:<projectId>` is one canvas key shared by every new conversation in a
 * project; the hand-off must copy it onto the session and then clear it.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { beforeEach, describe, expect, test } from "bun:test";
import {
  canvasPanelKey,
  clearPanelTabs,
  emptyPanelTabs,
  openPanelTab,
  readPanelTabs,
  writePanelTabs,
  type PanelTabState,
} from "./right-panel-tabs";

type Tab = "run" | "changes" | "editor";
const isTab = (tab: string): tab is Tab => tab === "run" || tab === "changes" || tab === "editor";
const kinds = (state: PanelTabState<Tab>) => state.tabs.map((tab) => tab.kind);

beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  };
});

function handOff(projectId: string, sessionId: string, panel: PanelTabState<Tab>) {
  writePanelTabs(sessionId, panel, 1);
  clearPanelTabs(canvasPanelKey(projectId));
}

describe("the canvas hand-off", () => {
  test("a new conversation starts with everything closed", () => {
    expect(readPanelTabs<Tab>(canvasPanelKey("project_1"), isTab)).toEqual(emptyPanelTabs<Tab>());
  });

  test("the arrangement built while writing the first message follows THAT session", () => {
    const arranged = openPanelTab(emptyPanelTabs<Tab>(), "run");
    writePanelTabs(canvasPanelKey("project_1"), arranged, 1);
    handOff("project_1", "session_a", arranged);
    const restored = readPanelTabs<Tab>("session_a", isTab);
    expect(restored.open).toBe(true);
    expect(kinds(restored)).toEqual(["run"]);
  });

  test("and the NEXT conversation in the same project does not inherit it", () => {
    const arranged = openPanelTab(emptyPanelTabs<Tab>(), "run");
    writePanelTabs(canvasPanelKey("project_1"), arranged, 1);
    handOff("project_1", "session_a", arranged);
    // The canvas the next conversation reads is the one just cleared.
    expect(readPanelTabs<Tab>(canvasPanelKey("project_1"), isTab)).toEqual(emptyPanelTabs<Tab>());
  });

  test("two sessions keep independent panels — closing one does not close the other", () => {
    writePanelTabs("session_a", openPanelTab(emptyPanelTabs<Tab>(), "run"), 1);
    writePanelTabs("session_b", openPanelTab(emptyPanelTabs<Tab>(), "changes"), 1);
    writePanelTabs("session_a", emptyPanelTabs<Tab>(), 2);
    expect(kinds(readPanelTabs<Tab>("session_a", isTab))).toEqual([]);
    expect(kinds(readPanelTabs<Tab>("session_b", isTab))).toEqual(["changes"]);
    expect(readPanelTabs<Tab>("session_b", isTab).open).toBe(true);
  });

  test("one project's canvas is not another's", () => {
    writePanelTabs(canvasPanelKey("project_1"), openPanelTab(emptyPanelTabs<Tab>(), "run"), 1);
    expect(readPanelTabs<Tab>(canvasPanelKey("project_2"), isTab)).toEqual(emptyPanelTabs<Tab>());
  });

  test("clearing a key that was never written is not an error", () => {
    expect(() => clearPanelTabs(canvasPanelKey("project_never"))).not.toThrow();
  });

  test("clearing the canvas leaves every session's panel untouched", () => {
    writePanelTabs("session_a", openPanelTab(emptyPanelTabs<Tab>(), "run"), 1);
    writePanelTabs(canvasPanelKey("project_1"), openPanelTab(emptyPanelTabs<Tab>(), "editor"), 1);
    clearPanelTabs(canvasPanelKey("project_1"));
    expect(kinds(readPanelTabs<Tab>("session_a", isTab))).toEqual(["run"]);
  });
});
