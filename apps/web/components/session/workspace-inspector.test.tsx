/**
 * THE NOTEBOOK, which is all the masthead's clipboard popover holds now.
 *
 * The section rather than the whole popover, because the popover's content is
 * portalled and does not exist until it is opened — there is no markup to
 * assert against from a server render. What is pinned here is the set of
 * decisions the section is easiest to regress on:
 *   · a note is a ROW with its first line beside it, which is what tells two
 *     notes with similar titles apart;
 *   · a row is a DRAG HANDLE as much as a button — the gesture that hands a
 *     note to the composer;
 *   · "write this down" is always reachable, notebook empty or not.
 *
 * Static markup, so the effects never run: the notes are handed in, which is
 * also why the section takes them as a prop.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectNote } from "@telar/engine-client";
import { InspectorNotes } from "./workspace-inspector";

const stamp = { label: "Thu 10:00", at: 1 };
const note = (extra: Partial<ProjectNote> = {}): ProjectNote =>
  ({
    id: "n-1",
    projectId: "p1",
    title: "Deploy",
    body: "# How to ship\nbun run ship",
    created: stamp,
    updated: stamp,
    author: "you",
    schemaVersion: 1,
    ...extra,
  }) as ProjectNote;

const render = (notes: ProjectNote[]) => renderToStaticMarkup(<InspectorNotes projectId="p1" notes={notes} />);

describe("the notes popover", () => {
  test("the project's notes are rows, titled, with their first line beside them", () => {
    const markup = render([note(), note({ id: "n-2", title: "Reviewers", body: "Ana reads the engine half" })]);
    expect(markup).toContain("Notes");
    expect(markup).toContain("Deploy");
    expect(markup).toContain("Reviewers");
    // A markdown heading is not the first LINE a reader wants — the hashes are
    // stripped and the heading's words stand in for the body.
    expect(markup).toContain("How to ship");
    expect(markup).toContain("Ana reads the engine half");
  });

  test("a row is a drag handle as much as a button", () => {
    // The whole point of the row: drag it into the composer and the note's body
    // lands in the message. Losing `draggable` loses the feature silently.
    expect(render([note()])).toContain('draggable="true"');
  });

  test("a pinned note wears the pin, an ordinary one the notebook", () => {
    // The pin is the only ordering signal the user sets by hand, so the row has
    // to say which notes carry it.
    expect(render([note({ pinned: true })])).toContain("lucide-pin");
    expect(render([note()])).toContain("lucide-notebook-pen");
  });

  test("writing a new one is always offered, notebook empty or not", () => {
    expect(render([])).toContain('aria-label="New note"');
    expect(render([note()])).toContain('aria-label="New note"');
  });

  test("a row promises no departure: no chevron", () => {
    // A note opens in place; a chevron would promise a departure.
    expect(render([note()])).not.toContain("lucide-chevron-right");
  });
});
