// ISSUE #47 — THE PINNED ENVIRONMENT IS THE PRESENT TENSE.
//
// Owner's ruling: "After a task is finished, failed, or whatever, it should be
// removed from it. Pinned env is to see what's happening." Three claims come
// out of that, and all three are structural rather than computational — a
// section that does not render, a list that is filtered before it is capped, a
// section that starts collapsed — so this is a STATIC SCAN, the same shape
// `spawn-reveal.test.ts` and `right-panel-mount.test.ts` use, for the same
// reason they use it: there is no DOM harness in this repo (story 3.1's hard
// rule 9) to open a popover and count rows in.
//
// The COMPUTATIONAL half of this change lives in `background-tasks.ts` and is
// tested for real in `background-tasks.test.ts` — kinds, pluralization, the
// composer's aggregate sentence, the tolerance of the wire normalizer. What is
// left here is wiring, and wiring is what a scan can actually prove.
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const WEB_ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB_ROOT), "utf8");
const inspector = () => read("components/session/workspace-inspector.tsx");
const sessionView = () => read("components/session/session-view.tsx");

/** Comments stripped — borrowed from `ultra-runs.test.ts`, and load-bearing
 *  here: this repo's comments narrate what a change REMOVED (by name, in
 *  code-shaped quotes), so a "the old mechanism is gone" assertion run over raw
 *  source would fail on the very sentence explaining that it is gone. The `[^:]`
 *  guard keeps `https://` in a string from eating the rest of a line. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("live-only: finished work leaves the pinned environment entirely", () => {
  test("Subagents and Ultras render FILTERED lists, and a section with nothing live renders nothing", () => {
    const src = inspector();
    expect(src).toContain('const liveAgents = agents.filter((agent) => agent.status === "running");');
    expect(src).toContain('const liveWorkflows = workflows.filter((run) => run.state === "running");');
    // The section gates read the filtered lists — `agents.length > 0` would
    // draw a heading over an empty body for a session whose agents have all
    // finished, which is precisely the "history in the now panel" this removes.
    expect(src).toContain("{liveAgents.length > 0 && (");
    expect(src).toContain("{liveWorkflows.length > 0 && (");
    const code = stripComments(src);
    expect(code).not.toContain("{agents.length > 0 && (");
    expect(code).not.toContain("{workflows.length > 0 && (");
  });

  test("no terminal state is rendered as a row any more — no 'Done', no 'Needs attention'", () => {
    const src = stripComments(inspector());
    expect(src).not.toContain('"Needs attention"');
    expect(src).not.toContain('agent.status === "error"');
    // `agentTone` mapped error→attention and done→default. With every row live,
    // the mapping had exactly one reachable answer and the function went with
    // the rows it existed for.
    expect(src).not.toContain("function agentTone");
  });

  test("the #48 order-before-cut machinery is gone from this panel — live-only supersedes it", () => {
    const src = stripComments(inspector());
    // Both orderings partitioned live rows above finished ones so the cap could
    // not hide a running row behind a page of settled ones. There are no
    // finished rows left here to sort against.
    expect(src).not.toContain("orderAgentsForPanel");
    expect(src).not.toContain("orderRunsForPanel");
    // The cap itself STAYS: a session can legitimately run more concurrent work
    // than a glance holds.
    expect(src).toContain("const SECTION_ROW_CAP = 5;");
  });

  test("the Activity rail is untouched — it still owns history", () => {
    // `orderRunsForPanel` lost its pinned-environment caller but not its
    // reason to exist: `splitRunsForRail` (the rail) is built on it, and the
    // rail is the surface that shows live and finished runs together.
    const ultraRuns = read("lib/ultra-runs.ts");
    expect(ultraRuns).toContain("export function orderRunsForPanel");
    expect(ultraRuns).toContain("for (const run of orderRunsForPanel(runs))");
  });
});

describe("Processes: the harness's live background tasks, beside Changes and Browser", () => {
  test("the section exists, renders type + description, and is capped like its neighbours", () => {
    const src = inspector();
    expect(src).toContain("<SectionHeading>Processes</SectionHeading>");
    expect(src).toContain("{processTasks.length > 0 && (");
    expect(src).toContain("label={backgroundTaskLabel(task)}");
    expect(src).toContain("detail={task.description}");
    expect(src).toContain('noun="processes"');
  });

  test("no double booking: agent-kind tasks stay out of Processes — Subagents owns them", () => {
    // The harness's roster includes backgrounded SUB-AGENTS (the SDK
    // backgrounds "Bash commands and subagents" onto one list), so without
    // this filter every running scout rendered TWICE in one popover: an
    // anonymous "Agent" row in Processes and its real card, with name and
    // steps, in Subagents directly below (owner's find on nightly .1).
    const src = inspector();
    expect(src).toContain('backgroundTaskKind(task.type) !== "agent"');
    // The section renders the FILTERED list, not the raw roster.
    expect(src).toContain("items={processTasks}");
    expect(src).not.toContain("items={tasks}");
  });

  test("rows are not clickable: a background command has no detail surface to go to", () => {
    // `InspectorRow` draws a chevron whenever an onClick is passed, and a
    // chevron promises somewhere to land. Agents and runs have the Activity
    // dock; a backgrounded command's output lands in the transcript.
    const src = inspector();
    const section = src.slice(src.indexOf("<SectionHeading>Processes"), src.indexOf("{liveAgents.length > 0"));
    expect(section).not.toContain("onClick=");
  });

  test("the list is streamed mid-turn and re-seeded at `done` — both REPLACE", () => {
    const view = sessionView();
    // Mid-turn (and, through the window sink's feed writes, between turns).
    expect(view).toContain('case "tasks":');
    expect(view).toContain("setBgTasks(normalizeBackgroundTasks(payload?.tasks));");
    // The turn's handoff.
    expect(view).toContain("setBgTasks(normalizeBackgroundTasks(payload.tasks));");
    // And the window's end clears it — rule 20's line and these rows must both
    // vanish the moment they stop being true.
    expect(view).toContain("setBgTasks([]);");
    expect(view).toContain("tasks={bgTasks}");
  });

  test("nothing pairs the roster against task_notification edges any more", () => {
    // The SDK is explicit that the level's ids must not be correlated with the
    // edge stream, and a level makes the arithmetic unnecessary: the old
    // `setBgTasksLive(n => Math.max(0, n - 1))` guess is gone with the count.
    const view = stripComments(sessionView());
    expect(view).not.toContain("setBgTasksLive");
    expect(view).not.toContain("bgTasksLive");
  });
});

describe("the composer's aggregate line is honest about type", () => {
  test("it asks the roster for its words instead of calling everything an agent", () => {
    const view = sessionView();
    expect(view).toContain("{backgroundWorkPhrase(bgTasks)}");
    // The old sentence, in both its singular and its templated form. Read over
    // stripped source: the removal note above the composer quotes it verbatim.
    const code = stripComments(view);
    expect(code).not.toContain('"1 agent still working"');
    expect(code).not.toContain("agents still working`");
  });

  test("Stop is unchanged: still the session-wide stop beside that line", () => {
    const view = sessionView();
    expect(view).toContain("{!busy && bgTasks.length > 0 && (");
    expect(view).toContain("<Button type=\"button\" size=\"xs\" variant=\"outline\" onClick={() => stopTurn()}>");
  });
});

describe("Context collapses hard: it is the one list that cannot self-prune", () => {
  test("the default is ONE summary row — count and total size", () => {
    const src = inspector();
    expect(src).toContain("function ContextSection");
    expect(src).toContain("const totalBytes = attachments.reduce((sum, item) => sum + item.size, 0);");
    expect(src).toContain("attachment${attachments.length === 1 ? \"\" : \"s\"} · ${formatBytes(totalBytes)}");
  });

  test("the capped attachment rows survive, behind the click", () => {
    const src = inspector();
    expect(src).toContain("aria-expanded={expanded}");
    expect(src).toContain("{expanded && (");
    expect(src).toContain('noun="attachments"');
    // The image hover preview is what made these rows worth having; it is
    // reached by expanding, not deleted.
    expect(src).toContain("<AttachmentRow item={item} key={item.id} />");
  });
});
