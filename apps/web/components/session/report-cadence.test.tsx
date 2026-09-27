/**
 * WHAT A CONVERSATION IS HOLDING FROM ITS PEERS — the retired cadence control.
 *
 * Reports never open a turn now (session-tools audit), so the row no longer
 * offers a cadence. It still admits what is held, because a held mailbox that
 * says nothing reads as a lost one.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HELD_DETAIL, heldLabel, ReportCadenceView } from "./report-cadence";

const view = (held: number) => renderToStaticMarkup(<ReportCadenceView held={held} />);

describe("the held row", () => {
  test("admits what it is holding, and says nothing when it holds nothing", () => {
    expect(heldLabel(3)).toBe("3 held");
    expect(heldLabel(0)).toBeUndefined();
    expect(view(3)).toContain(">3 held<");
    expect(view(0)).not.toContain("tabular-nums");
  });

  test("the held row carries a tone, so a glance at the panel sees it", () => {
    expect(view(3)).toContain('data-tone="info"');
    expect(view(0)).toContain('data-tone="none"');
  });

  test("offers no cadence any more, and says where the reports go", () => {
    expect(view(0)).not.toContain("As they arrive");
    expect(view(0)).not.toContain('aria-haspopup');
    // The markup escapes the apostrophe, so match the sentence up to it.
    expect(view(0)).toContain(HELD_DETAIL.split("'")[0]!);
    expect(view(0)).toContain("Reports from peers");
  });
});
