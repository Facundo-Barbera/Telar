/**
 * HOW WIDE THE PANEL OPENS, and whose answer that is.
 *
 * A Data or Editor tab at the list width (480px) is a notebook, a PDF page or
 * a file-beside-its-tree in a column too narrow for any of them, so every one
 * of them asked to be dragged wider on sight (#357). The rule has to raise the
 * DEFAULT without ever touching a width the person chose — including a narrow
 * one, which is the case a naive "make it at least 720" would quietly undo.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  defaultRightPanelWidth,
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_WIDE_DEFAULT_WIDTH,
} from "./right-panel-layout";

const tab = (kind: string) => ({ kind });

describe("defaultRightPanelWidth", () => {
  test("a strip of lists opens at the column width it always did", () => {
    expect(defaultRightPanelWidth([tab("diff"), tab("agents"), tab("issues")])).toBe(RIGHT_PANEL_DEFAULT_WIDTH);
    // An empty panel is not a wide one: there is nothing in it asking for room.
    expect(defaultRightPanelWidth([])).toBe(RIGHT_PANEL_DEFAULT_WIDTH);
  });

  test("a document surface opens wide", () => {
    expect(defaultRightPanelWidth([tab("editor")])).toBe(RIGHT_PANEL_WIDE_DEFAULT_WIDTH);
    expect(defaultRightPanelWidth([tab("data")])).toBe(RIGHT_PANEL_WIDE_DEFAULT_WIDTH);
  });

  test("the widest thing in the strip decides, wherever it sits and whichever is showing", () => {
    // Not the first tab and not the active one: a strip holding a notebook
    // needs the room whichever tab is in front, and reading the ACTIVE tab
    // would make the panel jump every time you switched between two of them.
    expect(defaultRightPanelWidth([tab("diff"), tab("editor")])).toBe(RIGHT_PANEL_WIDE_DEFAULT_WIDTH);
    expect(defaultRightPanelWidth([tab("editor"), tab("diff")])).toBe(RIGHT_PANEL_WIDE_DEFAULT_WIDTH);
  });

  test("the wide default is wider than the ordinary one, which is the whole claim", () => {
    expect(RIGHT_PANEL_WIDE_DEFAULT_WIDTH).toBeGreaterThan(RIGHT_PANEL_DEFAULT_WIDTH);
  });
});
