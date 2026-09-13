/**
 * #354 — THE HARNESS'S OWN TEMP PATHS DO NOT BELONG IN THE LANE.
 *
 * Packaged Dev 6aafdfe9, a data-science turn: three
 * `Read file /private/tmp/claude-502/bundled-skills/…/dataviz/…` rows and a
 * `Ran command cd /private/tmp/claude-502/… && node …`, drawn at the same size
 * as the work on the reader's project. These render the real components, so
 * "the path is not in the markup" IS "the reader is not shown it".
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityGroup, TranscriptWorkspace } from "./transcript";
import type { JournalItem } from "@/lib/engine/journal";

const base = { runId: "run_1", sessionId: "session_1", startedAt: 1, streamedText: "", openedBy: 0 } as const;
const WORKSPACE = "/Users/facundo/work/telar";
const SKILL_DIR = "/private/tmp/claude-502/bundled-skills/2.1.267/31072555b6351e965abe2d4388310e5b/dataviz";

const read = (id: string, path: string, status: JournalItem["status"] = "completed"): JournalItem => ({
  ...base,
  id,
  status,
  completedAt: 2,
  detail: { type: "file_read", read: { path } },
});

const ran = (id: string, command: string): JournalItem => ({
  ...base,
  id,
  status: "completed",
  completedAt: 2,
  detail: { type: "command_execution", command: { command } },
});

const render = (items: JournalItem[], { live = true, workspace = WORKSPACE as string | undefined } = {}) =>
  renderToStaticMarkup(
    <TranscriptWorkspace {...(workspace ? { path: workspace } : {})}>
      <ActivityGroup items={items} tasks={[]} live={live} />
    </TranscriptWorkspace>,
  );

describe("a skill the harness consulted", () => {
  test("folds to one named line instead of the temp path", () => {
    const html = render([read("item_a", `${SKILL_DIR}/SKILL.md`)]);
    expect(html).toContain("Consulted a skill: dataviz");
    expect(html).not.toContain("/tmp/claude-502");
  });

  test("a whole errand — three reads and the command that ran from there — is one line", () => {
    const items = [
      read("item_a", `${SKILL_DIR}/SKILL.md`),
      read("item_b", `${SKILL_DIR}/references/palette.md`),
      ran("item_c", `cd ${SKILL_DIR} && node scripts/plot.mjs`),
    ];
    // Live, the window shows the run's last row — the command — and it is the
    // errand's line rather than the `cd /private/tmp/…` it was made of.
    const live = render(items);
    expect(live).toContain("Consulted a skill: dataviz");
    expect(live).not.toContain("/tmp/claude-502");
    // Settled, the fold summarises it as the errand too, not as the file
    // operations it happened to be made of.
    const settled = render(items, { live: false });
    expect(settled).toContain("Consulted a skill ×3");
    expect(settled).not.toContain("Read file ×2");
  });

  test("the project's own work is untouched", () => {
    const html = render([read("item_a", `${WORKSPACE}/apps/web/components/transcript.tsx`)]);
    expect(html).toContain("apps/web/components/transcript.tsx");
    expect(html).not.toContain("Consulted a skill");
  });

  test("a failed harness row keeps its path — errors survive collapse", () => {
    const html = render([read("item_a", `${SKILL_DIR}/SKILL.md`, "failed")]);
    // Clipped by the row's own preview rule, but present and its own row.
    expect(html).toContain("/private/tmp/claude-502/bundled-skills");
    expect(html).toContain("Read file");
    expect(html).not.toContain("Consulted a skill");
  });

  test("a workspace that lives under the harness root is still the project", () => {
    // The dogfood fixture was /tmp/exoplanets: "under a temp directory" alone
    // is not evidence, which is why the rule has a second condition.
    const html = render([read("item_a", "/tmp/claude-502/project/src/main.ts")], { workspace: "/tmp/claude-502/project" });
    expect(html).toContain("/tmp/claude-502/project/src/main.ts");
    expect(html).not.toContain("Consulted");
  });

  test("without a workspace the harness root still decides on its own", () => {
    const html = render([read("item_a", `${SKILL_DIR}/SKILL.md`)], { workspace: undefined });
    expect(html).toContain("Consulted a skill: dataviz");
  });
});
