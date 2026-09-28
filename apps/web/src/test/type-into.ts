/**
 * TYPING INTO A CONTROLLED FIELD, FROM A TEST (#732).
 *
 * WHY A HELPER RATHER THAN `field.value = "…"`. React does not read the value
 * off the node when an `input` event arrives. It keeps a `_valueTracker` on
 * every controlled field and raises `onChange` only when the node's value
 * DIFFERS from the last value it stashed — that is how a component that resets
 * its own state avoids an echo. To install that tracker React redefines `value`
 * as an own property of the node, so a plain `field.value = "luna"` goes
 * through React's own setter, updates the tracker on the way past, and leaves
 * nothing for the change plugin to notice. The event fires; `onChange` does
 * not. This is true in a real browser too, and it is why the prototype setter
 * below is the standard move rather than a Happy DOM workaround — it is the
 * same one `@testing-library`'s `fireEvent.change` makes.
 *
 * WHAT WAS ACTUALLY BROKEN, and it was not this. #732 reported that no route
 * reached `onChange` under Happy DOM, prototype setter included. The cause was
 * import order, not the DOM: `react-dom` reads `canUseDOM` once at module scope
 * and derives `isInputEventSupported` from it, and a test file's static
 * `import` of `react-dom/client` is hoisted ABOVE its own
 * `GlobalRegistrator.register()` call. With no `window` at that moment React
 * froze the flag false and routed every controlled text input down its IE
 * `onpropertychange` polyfill, which never fires on an `input` event. The fix
 * is in `scripts/test-dom.mjs`, which now imports `react-dom/client` while the
 * preload's DOM is up. This helper is what makes the repaired path usable.
 *
 * ONE CHARACTER AT A TIME, because that is what the component sees from a
 * person: a field that reacts per keystroke (a live query, a debounce, a
 * completion menu) is exercised the way it will really be driven, and the
 * node's value is re-read each pass so a controlled field that rewrites what
 * you typed is followed rather than fought.
 */
import { act } from "react";

type TextField = HTMLInputElement | HTMLTextAreaElement;

/** The unpatched setter for this field's kind — the one React's per-node
 *  tracker setter shadows. Read lazily: these prototypes belong to whichever
 *  DOM is registered right now, and the suite registers more than one. */
function nativeValueSetter(field: TextField): (value: string) => void {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (!setter) throw new Error("no native `value` setter on this field's prototype — the DOM under the test is not the one this helper expects");
  return (value: string) => setter.call(field, value);
}

/**
 * Type `text` into `field`, as a person would: appended at the end of what is
 * already there, one character per `input` event, each one flushed so the
 * component has re-rendered before the next lands.
 *
 * Wrapped in `act` internally, so callers do not nest it in one of their own.
 */
export async function typeInto(field: TextField, text: string): Promise<void> {
  const write = nativeValueSetter(field);
  for (const character of text) {
    await act(async () => {
      write(field.value + character);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
}

/**
 * Empty `field` the way a select-all-and-delete does — one `input` event
 * carrying the empty string, which is the shape React's change plugin reads.
 */
export async function clearField(field: TextField): Promise<void> {
  const write = nativeValueSetter(field);
  await act(async () => {
    write("");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
