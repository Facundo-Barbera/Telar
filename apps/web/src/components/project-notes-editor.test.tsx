/**
 * THE QUICK EDITOR, pinned at the markup.
 *
 * Two properties, both easy to lose and neither visible to a typecheck:
 *   · it TEACHES ITS OWN SAVE. There is no save button, so the one line of
 *     status text is the entire contract with the user — a redesign that drops
 *     it leaves a box nobody is sure committed anything;
 *   · PROVENANCE IS SHOWN WHERE IT IS EDITED. A note an agent kept stays marked
 *     as one for the life of the note, and the editor is the only surface that
 *     can say so before the user rewrites it.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectNote } from "@telar/engine-client";
import { ProjectNoteEditor } from "./project-notes-editor";

const stamp = { label: "Thu 10:00", at: 1 };
const note = (extra: Partial<ProjectNote> = {}): ProjectNote =>
  ({ id: "n-1", projectId: "p1", title: "Deploy", body: "bun run ship", created: stamp, updated: stamp, author: "you", schemaVersion: 1, ...extra }) as ProjectNote;

const render = (props: Parameters<typeof ProjectNoteEditor>[0]) => renderToStaticMarkup(<ProjectNoteEditor {...props} />);

describe("the quick editor", () => {
  test("a new note is a blank title and a blank body, and says how it saves", () => {
    const markup = render({ projectId: "p1", onClose: () => {} });
    expect(markup).toContain("What is this about?");
    // No save button: blur is what actually happens, so the hint is the
    // contract. ⌘S is named because it is the key hands already press.
    expect(markup).toContain("Saves when you click away");
    expect(markup).toContain("⌘S");
  });

  test("an existing note arrives filled in, with a pin and a delete", () => {
    const markup = render({ projectId: "p1", note: note(), onClose: () => {} });
    expect(markup).toContain("Deploy");
    expect(markup).toContain("bun run ship");
    expect(markup).toContain('aria-label="Pin to the front"');
    expect(markup).toContain('aria-label="Delete this note"');
  });

  test("a pinned note offers to unpin rather than to pin again", () => {
    expect(render({ projectId: "p1", note: note({ pinned: true }), onClose: () => {} })).toContain('aria-label="Unpin"');
  });

  test("a note an agent wrote says so, and one the user wrote does not", () => {
    expect(render({ projectId: "p1", note: note({ author: "session" }), onClose: () => {} })).toContain("written by an agent");
    expect(render({ projectId: "p1", note: note(), onClose: () => {} })).not.toContain("written by an agent");
  });
});
