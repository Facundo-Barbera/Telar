/**
 * CANCEL CLOSES ON THE FIRST PRESS, on an empty form, with no complaint.
 *
 * The bug: on a blank "New run configuration" form, pressing Cancel first
 * showed "Give this configuration a name." and closed nothing; a second press
 * closed it. Cancel ran no validation — the BLUR did. Pressing a button blurs
 * the focused field on mousedown, the blur marked Name as touched, its
 * sentence appeared above the buttons, the row moved down under the pointer,
 * and the mouseup landed beside Cancel, so no click was delivered.
 *
 * MOUNTED, because every step of that is an event on a real element: the
 * mousedown whose default moves focus, the focusout that says where focus is
 * going, and the click. A static render has none of them.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { blurMarksTouched, CANCEL_MARK, RunConfigEditor } from "./run-config-editor";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

/** See `diff-row.test.tsx`: the registration is process-wide, and it is the
 *  NEXT file to register that dies without this. */
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

async function mountEmptyForm() {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root = createRoot(mount);
  roots.push(root);
  let cancelled = 0;
  const saved: unknown[] = [];
  await act(async () => {
    root.render(<RunConfigEditor onSave={(patch) => saved.push(patch)} onCancel={() => (cancelled += 1)} />);
  });
  const name = mount.querySelector('input[placeholder="Dev server"]') as HTMLInputElement;
  const cancel = [...mount.querySelectorAll("button")].find((button) => button.textContent === "Cancel") as HTMLButtonElement;
  return { mount, name, cancel, cancelled: () => cancelled, saved };
}

const alerts = (mount: HTMLElement) => [...mount.querySelectorAll('[role="alert"]')].map((node) => node.textContent);

describe("blurMarksTouched", () => {
  test("leaving a field for anywhere but Cancel counts as finishing it", () => {
    expect(blurMarksTouched(null)).toBe(true);
    const other = document.createElement("input");
    expect(blurMarksTouched(other)).toBe(true);
  });

  test("leaving it FOR Cancel does not", () => {
    const cancel = document.createElement("button");
    cancel.setAttribute(CANCEL_MARK, "");
    expect(blurMarksTouched(cancel)).toBe(false);
    // Inside it too — an icon in the button is still the button.
    const icon = document.createElement("span");
    cancel.appendChild(icon);
    expect(blurMarksTouched(icon)).toBe(false);
  });
});

describe("Cancel on an empty new configuration", () => {
  test("pressing Cancel keeps focus in the field, so nothing blurs and nothing moves", async () => {
    const { cancel } = await mountEmptyForm();
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    await act(async () => {
      cancel.dispatchEvent(press);
    });
    // The default of a mousedown on a button is to take focus; refusing it is
    // what stops the field's complaint from appearing mid-press.
    expect(press.defaultPrevented).toBe(true);
  });

  test("focus moving to Cancel says nothing, and one click closes", async () => {
    const { mount, name, cancel, cancelled, saved } = await mountEmptyForm();
    await act(async () => {
      name.focus();
    });
    // The keyboard route: Tab from Name onto Cancel.
    await act(async () => {
      name.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: cancel }));
    });
    expect(alerts(mount)).toEqual([]);

    await act(async () => {
      cancel.click();
    });
    expect(cancelled()).toBe(1);
    expect(saved).toEqual([]);
    expect(alerts(mount)).toEqual([]);
  });

  test("leaving Name for another field still explains what is missing", async () => {
    // The guard is about Cancel only; the rule it protects stays intact.
    const { mount, name } = await mountEmptyForm();
    const command = mount.querySelector('input[placeholder="bun run dev"]') as HTMLInputElement;
    await act(async () => {
      name.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: command }));
    });
    expect(alerts(mount)).toEqual(["Give this configuration a name."]);
  });
});
