// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMessageBubble } from "./conversation-message";

/**
 * An explicit TASK is the reason a session is doing anything, so it renders as
 * a message. A report is a peer talking, and stays collapsed.
 */
const sender = { sessionId: "session_coordinator" };

test("a TASK renders in full, with attribution and a link to its source", () => {
  const html = renderToStaticMarkup(
    <AgentMessageBubble text="Port the plugin host" sender={sender} intent="task" scope="engine only" />,
  );
  expect(html).toContain("Port the plugin host");
  expect(html).toContain("Task from another session");
  // Attribution is the ENGINE's, shown truthfully…
  expect(html).toContain("agent · session …inator");
  // …and links to where the words came from.
  expect(html).toContain("/sessions/session_coordinator");
  expect(html).toContain("engine only");
  // NOT collapsed.
  expect(html).not.toContain('aria-expanded="false"');
});

test("a REPORT stays collapsed and keeps its payload out of the chat view", () => {
  const html = renderToStaticMarkup(<AgentMessageBubble text="Checkpoint reached" sender={sender} intent="report" />);
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("Checkpoint reached");
});

test("an agent message with NO intent stays collapsed — the old behaviour", () => {
  const html = renderToStaticMarkup(<AgentMessageBubble text="Something" sender={sender} />);
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("Something");
});

test("a task from OUTSIDE any session is attributed truthfully and not linked", () => {
  // The user's own chat client on the sessions socket has no session to link to.
  const html = renderToStaticMarkup(<AgentMessageBubble text="Do this" sender={{}} intent="task" />);
  expect(html).toContain("Do this");
  expect(html).toContain("outside any session");
  expect(html).not.toContain("<a ");
});
