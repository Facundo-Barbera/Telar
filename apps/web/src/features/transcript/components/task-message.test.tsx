// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMessageBubble } from "./conversation-message";

/**
 * A PEER'S MESSAGE IS A COLLAPSED ROW, WHATEVER IT MEANT BY SENDING.
 *
 * A task used to render in full here — the instruction is why the session is
 * doing anything, so it read as a message. It also let a peer decide how much
 * of someone else's prose sat between two of the reader's own messages, which
 * on the phone was 3 KB of a worker's report. The notice carries the opening
 * and the scope; the body opens on tap.
 */
const sender = { sessionId: "session_coordinator" };

test("a TASK collapses, labelled by its intent with the scope on the header", () => {
  const html = renderToStaticMarkup(
    <AgentMessageBubble text="Port the plugin host" sender={sender} intent="task" scope="engine only" />,
  );
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain(">Task<");
  expect(html).toContain("engine only");
  // The instruction itself is behind the disclosure, not in the chat view.
  expect(html).not.toContain("Port the plugin host");
  expect(html).not.toContain("Task from another session");
});

test("a REPORT stays collapsed and keeps its payload out of the chat view", () => {
  const html = renderToStaticMarkup(<AgentMessageBubble text="Checkpoint reached" sender={sender} intent="report" />);
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain(">Report<");
  expect(html).not.toContain("Checkpoint reached");
});

test("an agent message with NO intent stays collapsed under the old wording", () => {
  // A message steered mid-turn carries no intent — the engine stamps that on
  // the turn — and must not read as a different kind of thing for it.
  const html = renderToStaticMarkup(<AgentMessageBubble text="Something" sender={sender} />);
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("Agent message");
  expect(html).not.toContain("Something");
});

test("a task from OUTSIDE any session is attributed truthfully and not linked", () => {
  // The user's own chat client on the sessions socket has no session to link to.
  const html = renderToStaticMarkup(<AgentMessageBubble text="Do this" sender={{}} intent="task" />);
  expect(html).toContain("outside any session");
  expect(html).not.toContain("<a ");
});

test("the collapsed row never carries the body, however long the body is", () => {
  // The bug in the issue, as a size: a 3 KB report is a row, not a wall.
  const body = "## Implementation checkpoint\n".repeat(200);
  for (const intent of ["task", "report", "result", "blocker", undefined]) {
    const html = renderToStaticMarkup(
      <AgentMessageBubble text={body} sender={sender} {...(intent ? { intent } : {})} />,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Implementation checkpoint");
  }
});
