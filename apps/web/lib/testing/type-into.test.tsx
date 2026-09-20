/**
 * A CONTROLLED FIELD CAN BE TYPED INTO, FROM A TEST (#732).
 *
 * THIS FILE IS THE REGRESSION, not a test of a utility. #732 recorded that no
 * route reached `onChange` for a controlled text input in this app's test
 * environment, and that across 81 `.test.tsx` files not one typed into one —
 * the absence being the finding. The cause turned out to be import order in the
 * shared preload rather than a Happy DOM gap (see `scripts/test-dom.mjs`), and
 * the way that repair breaks again is silent: someone drops the
 * `react-dom/client` import from the preload as dead weight, every existing
 * test still passes, and typing stops working for whoever needs it next.
 *
 * So the assertion below is deliberately the plainest possible statement of the
 * gap #732 is about: a `<input value={…} onChange={…} />`, typed into, state
 * read back. On the preload as it stood when this was written it fails with
 * `""`, and it fails for a reason no message in the run would explain.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { clearField, typeInto } from "./type-into";

/** Registered here and released in `afterAll` — Happy DOM throws on a second
 *  `register`, so a file that takes a DOM and never gives it back fails
 *  whichever file runs next. */
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(node);
  });
  return host;
}

/**
 * The narrowest controlled field there is, with its STATE RENDERED beside it.
 *
 * The state is read back out of that second node rather than out of a module
 * variable, because what #732 could not move was the state as the component
 * re-renders it — and a variable assigned during render would say so only if a
 * render happened, which is the very thing in question.
 */
function ControlledInput({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <input
        value={value}
        onChange={(event) => {
          keystrokes.push(event.target.value);
          setValue(event.target.value);
        }}
      />
      <output>{value}</output>
    </>
  );
}

function ControlledTextarea() {
  const [value, setValue] = useState("");
  return (
    <>
      <textarea value={value} onChange={(event) => setValue(event.target.value)} />
      <output>{value}</output>
    </>
  );
}

/** Every value `onChange` was handed, in order — so "it arrived" and "it
 *  arrived one keystroke at a time" are separate claims. Pushed from the event
 *  handler, never from render. */
let keystrokes: string[] = [];

/** The state, as the component last rendered it. */
const seen = (host: HTMLElement) => host.querySelector("output")!.textContent;
const field = (host: HTMLElement) => host.querySelector("input")!;

describe("typing drives a controlled input's state", () => {
  test("the state holds what was typed — the whole of #732 in one line", async () => {
    keystrokes = [];
    const host = await mount(<ControlledInput />);
    await typeInto(field(host), "luna");
    expect(seen(host)).toBe("luna");
  });

  test("and the node agrees, so a later read of the DOM is not a different answer", async () => {
    const host = await mount(<ControlledInput />);
    await typeInto(field(host), "luna");
    expect(field(host).value).toBe("luna");
  });

  test("one `onChange` per character, each carrying the value so far", async () => {
    keystrokes = [];
    const host = await mount(<ControlledInput />);
    await typeInto(field(host), "luna");
    // A field that debounces or completes per keystroke is driven the way a
    // person drives it, rather than handed the finished string once.
    expect(keystrokes).toEqual(["l", "lu", "lun", "luna"]);
  });

  test("typing appends to what the field already holds, as a caret at the end would", async () => {
    const host = await mount(<ControlledInput initial="luna" />);
    await typeInto(field(host), "tic");
    expect(seen(host)).toBe("lunatic");
  });

  test("clearing empties it", async () => {
    const host = await mount(<ControlledInput initial="luna" />);
    await clearField(field(host));
    expect(seen(host)).toBe("");
    expect(field(host).value).toBe("");
  });

  test("a textarea is drivable by the same route", async () => {
    const host = await mount(<ControlledTextarea />);
    await typeInto(host.querySelector("textarea")!, "luna");
    expect(seen(host)).toBe("luna");
  });
});

/**
 * THE MECHANISM, pinned so that a future failure says WHICH half broke.
 *
 * If typing regresses, these two say whether React's change plugin stopped
 * being reachable (the #732 failure) or the helper stopped writing past the
 * tracker. Without them the only evidence is `""`, which is what made #732 read
 * as a Happy DOM limitation for as long as it did.
 */
describe("why the prototype setter is the route", () => {
  test("a plain assignment is absorbed by React's own tracker and raises nothing", async () => {
    const host = await mount(<ControlledInput />);
    const node = field(host);
    await act(async () => {
      node.value = "luna";
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Not a bug, and true in a real browser: React redefines `value` on the
    // node, so this write updates the tracker on the way past and leaves no
    // mismatch for the change plugin to find.
    expect(seen(host)).toBe("");
  });

  test("React's change plugin is on the `input` path at all — the flag #732 was really about", async () => {
    const host = await mount(<ControlledInput />);
    const node = field(host);
    const write = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      write.call(node, "luna");
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // With `isInputEventSupported` frozen false — react-dom imported before any
    // DOM existed — React routes this down its IE `onpropertychange` polyfill
    // and `seen` stays `""` no matter how genuine the mismatch is.
    expect(seen(host)).toBe("luna");
  });
});
