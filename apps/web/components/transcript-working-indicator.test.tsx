/**
 * #431 — A COMPACTION IS NOT A STALL.
 *
 * The working indicator turns amber with "· no output Ns" after twenty seconds
 * of silence, which is the one readout that distinguishes a slow turn from a
 * stuck one. A context compaction emits nothing by construction and routinely
 * runs past thirty seconds, so it tripped the warning EVERY time — the session
 * read as hung at exactly the moment the provider was doing the most necessary
 * thing it does.
 *
 * These render the indicator the way `session-cockpit` does — label and
 * `delegated` from `turnActivity`, `compacting` from `isCompacting` — so what is
 * asserted is the wiring and not just the prop.
 *
 * THE INDICATOR OWNS ITS CLOCK (#498), so "now" is no longer a prop these can
 * set. It seeds from `Date.now()` on its first render, which is what the stub
 * below pins: the turn started a minute before whatever the component reads.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Item, Turn } from "@telar/engine-client";
import { isCompacting, projectJournal, type JournalTurn } from "@/lib/engine/journal";
import { turnActivity, WorkingIndicator } from "./transcript";

const STARTED = 1_000_000;
/** Three times the twenty-second threshold: unambiguously quiet. */
const NOW = STARTED + 60_000;

const realNow = Date.now;
beforeEach(() => {
  Date.now = () => NOW;
});
afterEach(() => {
  Date.now = realNow;
});

const turn: Turn = { runId: "run_1", sessionId: "s1", sequence: 1, input: "Please help", state: "running", acceptedAt: STARTED, updatedAt: STARTED };

/** A turn holding one `context_compaction` row, open or closed, and silent
 *  since the moment it started. */
const quietTurn = (status: Item["status"]): JournalTurn => {
  const compaction: Item = {
    runId: "run_1",
    sessionId: "s1",
    id: "cc",
    status,
    startedAt: STARTED,
    ...(status === "completed" ? { completedAt: STARTED } : {}),
    detail: { type: "context_compaction" },
  };
  return { ...projectJournal([turn], [compaction], [])[0]!, startedAt: STARTED, lastActivityAt: STARTED };
};

/** Exactly the cockpit's call site (`session-cockpit.tsx`). */
const render = (subject: JournalTurn) => {
  const doing = turnActivity(subject);
  return renderToStaticMarkup(
    <WorkingIndicator
      label={doing.label}
      delegated={doing.delegated}
      compacting={isCompacting(subject)}
      startedAt={subject.startedAt}
      lastActivityAt={subject.lastActivityAt}
    />,
  );
};

describe("the working indicator on a turn quiet for a minute", () => {
  test("says nothing about no output while a compaction is in flight", () => {
    const html = render(quietTurn("inProgress"));
    expect(html).not.toContain("no output");
    // …and not amber either: the dot and the label are the ordinary muted pair.
    expect(html).not.toContain("bg-warning");
    // The line still says what is happening, which is the other half of the fix:
    // a minute of silence with no explanation is its own kind of stuck.
    expect(html).toContain("Compacting context");
  });

  test("warns on the very same turn once the compaction has closed", () => {
    const html = render(quietTurn("completed"));
    expect(html).toContain("no output");
    expect(html).toContain("1m 00s");
    expect(html).toContain("bg-warning");
  });

  test("suppression is the compacting flag itself, not the turn's shape", () => {
    const subject = quietTurn("inProgress");
    const html = renderToStaticMarkup(
      <WorkingIndicator label="Compacting context" startedAt={subject.startedAt} lastActivityAt={subject.lastActivityAt} />,
    );
    expect(html).toContain("no output");
  });
});
