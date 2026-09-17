/**
 * `window.telar`, EXERCISED THE WAY THE QUEST CLIENT WILL USE IT (#548).
 *
 * These mount the real `Composer` and call the real page API, because every
 * claim here is about the seam between them: that the text goes through the
 * editor's own insertion (spacing, caret, commit) rather than around it, that
 * the send obeys the guard the Enter key obeys, and that "the active composer"
 * is the one a person is looking at. A test that called the registry directly
 * would pass with the composer wired to nothing.
 *
 * THE DOM IS REGISTERED FOR THIS FILE and handed back in `afterAll`: the suite
 * shares one process and most of its neighbours are written for a world with no
 * `window` in it. The preload (scripts/test-dom.mjs) has already settled the one
 * decision that has to be made before any test file loads.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Composer } from "@/components/composer";
import { installPageApi, type TelarPageApi } from "./page-api";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const telar = (): TelarPageApi => {
  const api = (window as typeof window & { telar?: TelarPageApi }).telar;
  if (!api) throw new Error("window.telar was never installed");
  return api;
};

beforeAll(() => {
  installPageApi();
});

/** One composer, with its draft owned by a parent the way the cockpit owns it —
 *  so "committed to React state" is a claim this harness can actually make. */
function Box({
  kind,
  initial = "",
  ready = true,
  onSent,
}: {
  kind: "session" | "agent";
  initial?: string;
  ready?: boolean;
  /** Handed the draft THIS RENDER holds — which is what the cockpit's own
   *  `onSubmit` sends, and so the only honest way to ask whether a dictated
   *  sentence actually went out. */
  onSent?: (draft: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <>
      <p data-testid={`state-${kind}`}>{draft}</p>
      <Composer
        draft={draft}
        kind={kind}
        ready={ready}
        attachments={[]}
        onAttach={() => {}}
        busy={false}
        sending={false}
        backgroundTasks={0}
        onDraftChange={setDraft}
        onSubmit={() => onSent?.(draft)}
        onStop={() => {}}
        onStopBackground={() => {}}
        onRuntimeMode={() => {}}
      />
    </>
  );
}

/** `act` returns a thenable rather than the callback's value, and every call
 *  here answers synchronously — that is the API's whole shape. */
function inAct<T>(fn: () => T): T {
  let value!: T;
  act(() => {
    value = fn();
  });
  return value;
}

const roots: { root: Root; host: HTMLElement }[] = [];

function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  roots.push({ root, host });
  return host;
}

afterEach(() => {
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
});

const editorIn = (host: HTMLElement): HTMLElement => {
  const box = host.querySelector<HTMLElement>('[data-slot="composer-editor"]');
  if (!box) throw new Error("no composer editor rendered");
  return box;
};

/** Focus the box the way a click does, and let React hear about it: happy-dom's
 *  `focus()` moves `document.activeElement`, and React's `onFocus` is wired to
 *  the bubbling `focusin`. */
function focus(box: HTMLElement): void {
  act(() => {
    box.focus();
    box.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  });
}

/** Put the caret at a draft offset inside the first text node — the state a
 *  person leaves behind by clicking in the middle of what they wrote. */
function caretAt(box: HTMLElement, offset: number): void {
  const text = box.firstChild;
  if (!text) throw new Error("the box painted nothing to put a caret in");
  const range = document.createRange();
  range.setStart(text, offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

const stateOf = (host: HTMLElement, kind: string): string =>
  host.querySelector(`[data-testid="state-${kind}"]`)?.textContent ?? "";

describe("dictate", () => {
  test("lands at the caret, spaced, and is committed to the draft React owns", () => {
    const host = mount(<Box kind="session" initial="fix the tests" />);
    const box = editorIn(host);
    focus(box);
    // Between "fix" and " the tests" — mid-sentence, where a spoken correction
    // actually arrives.
    caretAt(box, 3);

    const result = inAct(() => telar().dictate("failing"));

    expect(result).toEqual({ ok: true, draft: "fix failing the tests" });
    // THE POINT OF GOING THROUGH `insertAtCaret`: the spacing is the editor's,
    // so a dictated word reads like a typed one instead of "fixfailing".
    expect(stateOf(host, "session")).toBe("fix failing the tests");
    expect(box.textContent).toBe("fix failing the tests");
  });

  test("with an empty box it is the whole draft, and the caret is left after it", () => {
    const host = mount(<Box kind="session" />);
    focus(editorIn(host));

    const result = inAct(() => telar().dictate("open the door"));

    expect(result.ok).toBe(true);
    expect(stateOf(host, "session")).toBe("open the door ");
    // A second call continues the sentence rather than overwriting it.
    act(() => telar().dictate("please"));
    expect(stateOf(host, "session")).toBe("open the door please ");
  });

  test("submit: true sends the sentence it just inserted, not the draft before it", () => {
    const sent: string[] = [];
    const host = mount(<Box kind="session" onSent={(draft) => sent.push(draft)} />);
    focus(editorIn(host));

    const result = inAct(() => telar().dictate("ship it", { submit: true }));

    expect(result).toEqual({ ok: true, draft: "ship it ", submitted: true });
    // THE CLAIM THE WHOLE `flushSync` EXISTS FOR. Insert and send are one call
    // here, while a keystroke and the Enter after it are two events with a
    // render between them — so without a synchronous commit the cockpit would
    // have sent the empty draft it was still holding and reported success.
    expect(sent).toEqual(["ship it "]);
  });

  test("a refused send keeps the words — the box is never silently emptied", () => {
    const sent: string[] = [];
    const host = mount(<Box kind="session" ready={false} onSent={(draft) => sent.push(draft)} />);
    focus(editorIn(host));

    const result = inAct(() => telar().dictate("ship it", { submit: true }));

    // The box is disabled while the session is not ready, so nothing was
    // inserted either — and the refusal says which of the two happened.
    expect(result.ok).toBe(false);
    expect(sent).toEqual([]);
    expect(stateOf(host, "session")).toBe("");
  });
});

describe("submit obeys the guards the Enter key obeys", () => {
  test("an empty box does not send", () => {
    const sent: string[] = [];
    const host = mount(<Box kind="session" onSent={(draft) => sent.push(draft)} />);
    focus(editorIn(host));
    expect(telar().submit()).toEqual({ ok: false, reason: "There is nothing to send." });
    expect(sent).toEqual([]);
  });

  test("whitespace alone does not send", () => {
    const host = mount(<Box kind="session" initial="   " />);
    focus(editorIn(host));
    expect(telar().submit().ok).toBe(false);
  });

  test("a conversation that is not ready does not send", () => {
    const sent: string[] = [];
    const host = mount(<Box kind="session" initial="hello" ready={false} onSent={(draft) => sent.push(draft)} />);
    focus(editorIn(host));
    expect(telar().submit().ok).toBe(false);
    expect(sent).toEqual([]);
  });

  test("a ready box with text sends exactly once, carrying the draft", () => {
    const sent: string[] = [];
    const host = mount(<Box kind="session" initial="hello" onSent={(draft) => sent.push(draft)} />);
    focus(editorIn(host));
    expect(telar().submit()).toEqual({ ok: true });
    expect(sent).toEqual(["hello"]);
  });
});

describe("composer()", () => {
  test("reports the Agent screen's box when that is the focused one", () => {
    const session = mount(<Box kind="session" initial="in the session" />);
    const agent = mount(<Box kind="agent" initial="in the agent" />);

    focus(editorIn(agent));
    expect(telar().composer()).toEqual({ id: "agent-prompt", kind: "agent", draft: "in the agent", focused: true });

    // And it follows the caret back.
    focus(editorIn(session));
    expect(telar().composer()).toEqual({ id: "turn-prompt", kind: "session", draft: "in the session", focused: true });
  });

  test("the attributes an external client selects on are on the editable root", () => {
    const agent = mount(<Box kind="agent" />);
    const box = editorIn(agent);
    expect(box.getAttribute("data-composer")).toBe("agent");
    expect(box.getAttribute("id")).toBe("agent-prompt");
    expect(editorIn(mount(<Box kind="session" />)).getAttribute("data-composer")).toBe("session");
  });

  test("dictation goes to the composer the caret is in", () => {
    const session = mount(<Box kind="session" />);
    const agent = mount(<Box kind="agent" />);

    focus(editorIn(agent));
    act(() => telar().dictate("for the agent"));

    expect(stateOf(agent, "agent")).toBe("for the agent ");
    expect(stateOf(session, "session")).toBe("");
  });
});

describe("with no composer on screen", () => {
  test("all three say so rather than guessing at an element", () => {
    expect(telar().composer()).toBeNull();
    expect(telar().dictate("nowhere")).toEqual({ ok: false, reason: "No message box is on screen to type into." });
    expect(telar().submit()).toEqual({ ok: false, reason: "No message box is on screen to type into." });
  });
});

describe("the object itself", () => {
  test("is frozen, so a page script cannot replace a call another one trusts", () => {
    expect(Object.isFrozen(telar())).toBe(true);
  });

  test("installing twice is a no-op rather than a second object", () => {
    const first = telar();
    installPageApi();
    expect(telar()).toBe(first);
  });
});
