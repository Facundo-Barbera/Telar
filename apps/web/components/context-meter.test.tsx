/**
 * THE CONTEXT METER'S READING (#539).
 *
 * What must not drift:
 *
 *   - a provider that reported no tokens draws a context percentage and NOT a
 *     zero token count, because "nobody said" and "that turn was free" are
 *     different facts;
 *   - the percentage is of TELAR'S trim budget, which is the ceiling that will
 *     actually drop the oldest exchange;
 *   - a prompt over budget draws full rather than overflowing — the newest block
 *     survives any budget, so >100% is a real state;
 *   - nothing is drawn at all before a turn has ended, because a gauge reading
 *     empty is a number that is wrong rather than missing;
 *   - a fold says how many turns it cost (#567), and only when it cost some: the
 *     engine now folds to a LOW-water mark, so the reading really does fall from
 *     full to two thirds between two turns and needs a sentence beside it.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextMeter, contextMeterReading } from "./context-meter";

describe("what the meter reads", () => {
  test("tokens and context are both shown, because neither substitutes for the other", () => {
    const reading = contextMeterReading({ usage: { input: 2_600, output: 90, total: 2_690 }, contextChars: 30_000, budgetChars: 120_000 });
    expect(reading).toMatchObject({ percent: 25, tokens: "2,690 tokens", label: "2,690 tokens · 25% context" });
    // The tooltip says which number is which, for the reader who wonders.
    expect(reading!.title).toContain("as the model reported them");
    expect(reading!.title).toContain("30,000 of 120,000 characters");
  });

  test("a provider that reported nothing loses the token half and keeps the context half", () => {
    const reading = contextMeterReading({ contextChars: 12_000, budgetChars: 120_000 });
    expect(reading).toMatchObject({ percent: 10, label: "10% context" });
    expect(reading!.tokens).toBeUndefined();
    // NOT "0 tokens": that would assert the turn was free.
    expect(reading!.label).not.toContain("0 tokens");
    expect(reading!.title).toContain("reported no token count");
  });

  test("a prompt over budget reads full rather than overflowing", () => {
    // The trim keeps the newest block whatever it costs, so this is reachable.
    expect(contextMeterReading({ contextChars: 400_000, budgetChars: 120_000 })!.percent).toBe(100);
  });

  test("a fold that happened is named, so a meter that halved itself explains why", () => {
    const reading = contextMeterReading({ usage: { input: 60_000, output: 400, total: 60_400 }, contextChars: 68_000, budgetChars: 120_000, folded: 9 });
    expect(reading).toMatchObject({ folded: "folded 9 turns", label: "60,400 tokens · 57% context · folded 9 turns" });
    expect(reading!.title).toContain("folded 9 turns to one line each");
    // One turn is one turn.
    expect(contextMeterReading({ contextChars: 68_000, budgetChars: 120_000, folded: 1 })!.label).toBe("57% context · folded 1 turn");
  });

  test("a turn that folded nothing says nothing — and neither does a Mac too old to say", () => {
    // "folded 0 turns" on every ordinary turn would be noise in the one place
    // on this screen that has to stay quiet.
    expect(contextMeterReading({ contextChars: 12_000, budgetChars: 120_000, folded: 0 })!.label).toBe("10% context");
    expect(contextMeterReading({ contextChars: 12_000, budgetChars: 120_000, folded: 0 })!.folded).toBeUndefined();
    expect(contextMeterReading({ contextChars: 12_000, budgetChars: 120_000 })!.folded).toBeUndefined();
  });

  test("there is no reading before a turn has ended, or without a ceiling to measure against", () => {
    expect(contextMeterReading(undefined)).toBeUndefined();
    // A zero budget would make every percentage a division by nothing.
    expect(contextMeterReading({ contextChars: 10, budgetChars: 0 })).toBeUndefined();
  });
});

describe("what the meter draws", () => {
  test("a level rather than a progress bar, with the percentage on it for a screen reader", () => {
    const html = renderToStaticMarkup(<ContextMeter usage={{ input: 100, output: 20, total: 120 }} contextChars={60_000} budgetChars={120_000} />);
    // `meter`, not `progressbar`: nothing is in progress — this is a level.
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain("50% of the context budget");
    expect(html).toContain("120 tokens · 50% context");
  });

  test("a crowded conversation is coloured, an ordinary one is not", () => {
    const roomy = renderToStaticMarkup(<ContextMeter contextChars={12_000} budgetChars={120_000} />);
    const crowded = renderToStaticMarkup(<ContextMeter contextChars={108_000} budgetChars={120_000} />);
    expect(roomy).not.toContain("text-warning");
    // The warning arrives BEFORE history is lost, not after.
    expect(crowded).toContain("text-warning");
  });

  test("nothing at all when there is nothing honest to show", () => {
    expect(renderToStaticMarkup(<ContextMeter contextChars={10} budgetChars={0} />)).toBe("");
  });
});
