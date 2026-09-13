/**
 * THE REPORTED BUG: "every conversation opens with Run showing".
 *
 * The panel store was already per-session and already started empty, so
 * per-session state was never the cause. The cause is the CANVAS key:
 * `new:<projectId>` is ONE key shared by every new conversation in a project,
 * and creating a session copies it onto the new session. Left in place, the
 * hand-off became a default that every later conversation inherited.
 *
 * These pin both halves — the hand-off still happens, and the canvas forgets.
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
/** The strip as KINDS — the hand-off is about which surfaces travel, not about
 *  which instance ids they took. */
const kinds = (state: PanelTabState<Tab>) => state.tabs.map((tab) => tab.kind);

/** A localStorage that behaves like the real one, per test. */
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

/** What the cockpit does when the first message creates the session. */
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
