/**
 * THE CADENCE CONTROL — issue #723.
 *
 * The engine can hold routine peer reports and deliver them together; what it
 * could not do was let a person SEE that, or change it. So these tests read for
 * the two facts the control exists to carry: which cadence is set, and — the
 * half that makes a held mailbox trustworthy — how much it is holding.
 *
 * THE DECISIONS ARE TESTED AS DECISIONS, the same split as
 * `related-conversations.test.tsx` next door. What a cadence is called, which
 * options a menu offers a session an agent set to something odd, and WHEN a
 * count is allowed to appear are choices; proving them through a rendered
 * string proves them twice as slowly and half as clearly.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CADENCES, cadenceDetail, cadenceFromValue, cadenceLabel, cadenceOptions, cadenceValue, heldLabel, ReportCadenceView } from "./report-cadence";

const view = (props: Partial<React.ComponentProps<typeof ReportCadenceView>> = {}) =>
  renderToStaticMarkup(<ReportCadenceView minutes={null} held={0} {...props} />);

describe("cadenceLabel", () => {
  test("no window is named, not left blank — the default is a choice a reader can see", () => {
    expect(cadenceLabel(null)).toBe("As they arrive");
  });

  test("minutes, hours, and the awkward numbers in between", () => {
    expect(cadenceLabel(1)).toBe("Every minute");
    expect(cadenceLabel(25)).toBe("Every 25 minutes");
    expect(cadenceLabel(60)).toBe("Every hour");
    expect(cadenceLabel(120)).toBe("Every 2 hours");
    // 90 is neither: "1.5 hours" reads worse than the number a person set.
    expect(cadenceLabel(90)).toBe("Every 90 minutes");
  });
});

describe("cadenceOptions", () => {
  test("the offered list, unchanged, for a session set to one of them", () => {
    expect(cadenceOptions(null)).toEqual([...CADENCES]);
    expect(cadenceOptions(25)).toEqual([...CADENCES]);
  });

  test("a window an AGENT set joins the list, in its place", () => {
    // `sessions_report_window` accepts any whole minute up to a day, so a menu
    // that could not show 7 would open with nothing selected — the control
    // disagreeing with the row it sits on.
    expect(cadenceOptions(7)).toEqual([null, 5, 7, 10, 15, 25, 30, 60]);
    expect(cadenceOptions(240)).toEqual([null, 5, 10, 15, 25, 30, 60, 240]);
  });
});

describe("cadenceValue / cadenceFromValue", () => {
  test("every offered cadence survives the round trip", () => {
    for (const cadence of CADENCES) expect(cadenceFromValue(cadenceValue(cadence))).toBe(cadence);
  });

  test("anything unrecognised reads as the DEFAULT, never as a window", () => {
    // The failure that matters is the one that starts holding mail nobody asked
    // to have held, so an unreadable value falls back to arrival delivery.
    expect(cadenceFromValue("")).toBe(null);
    expect(cadenceFromValue("nonsense")).toBe(null);
    expect(cadenceFromValue("2.5")).toBe(null);
    expect(cadenceFromValue("0")).toBe(null);
    expect(cadenceFromValue(String(24 * 60 + 1))).toBe(null);
    // The contract's own edges are windows, not nonsense.
    expect(cadenceFromValue("1")).toBe(1);
    expect(cadenceFromValue(String(24 * 60))).toBe(24 * 60);
  });
});

describe("heldLabel", () => {
  test("a count only under a window, because only then is this control the cause", () => {
    expect(heldLabel(25, 3)).toBe("3 held");
    expect(heldLabel(25, 1)).toBe("1 held");
  });

  test("nothing held is not a fact worth a number", () => {
    expect(heldLabel(25, 0)).toBeUndefined();
  });

  test("a BUSY session's backlog is not the window's doing, so the row does not claim it", () => {
    // Mail waits for a running turn whatever the cadence says. A count beside
    // "as they arrive" would credit this setting with a delay it is not causing.
    expect(heldLabel(null, 4)).toBeUndefined();
  });
});

describe("cadenceDetail", () => {
  test("each state says what it MEANS, rather than repeating the setting", () => {
    expect(cadenceDetail(null, false)).toContain("as it arrives");
    expect(cadenceDetail(25, false)).toContain("held and delivered together");
    // The three that are never held are named where the person is deciding —
    // a window that swallowed a blocker would be the feature's worst failure.
    expect(cadenceDetail(25, false)).toContain("blocker");
  });

  test("a failed write owns the line, rather than the row pretending it landed", () => {
    expect(cadenceDetail(25, true)).toBe("That did not go through — try again.");
  });
});

describe("the row", () => {
  test("names the cadence it is set to", () => {
    expect(view({ minutes: 25 })).toContain("Every 25 minutes");
    expect(view({ minutes: null })).toContain("As they arrive");
  });

  test("admits what it is holding", () => {
    expect(view({ minutes: 25, held: 3 })).toContain(">3 held<");
    // The trailing span itself is gone, not merely emptied — matched on the
    // class it is the only bearer of, because "held" also appears in the
    // sentence underneath and would make this assertion pass for free.
    expect(view({ minutes: 25, held: 0 })).not.toContain("tabular-nums");
  });

  test("the held row carries a tone, so a glance at the panel sees it", () => {
    expect(view({ minutes: 25, held: 3 })).toContain('data-tone="info"');
    expect(view({ minutes: 25, held: 0 })).toContain('data-tone="none"');
  });

  test("a write in flight disables the control rather than showing a value it has not got", () => {
    // `data-disabled`, not `disabled`: the trigger's own class list carries
    // `disabled:opacity-40` whatever its state, so the bare word is always
    // present and proves nothing.
    expect(view({ minutes: 25, busy: true })).toContain('data-disabled=""');
    expect(view({ minutes: 25, busy: false })).not.toContain('data-disabled=""');
  });

  test("the region is named in the panel's own register", () => {
    expect(view()).toContain("Reports from peers");
  });
});
