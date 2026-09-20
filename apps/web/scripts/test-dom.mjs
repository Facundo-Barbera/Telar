/**
 * A DOM, for exactly as long as the modules that freeze an answer at import
 * need to see one.
 *
 * THE PROBLEM. Some modules decide ONCE, when they are first imported, what
 * the environment can do — and keep that answer for the life of the process.
 * The suite shares a process, so whichever file imports them first settles it
 * for every file after, and registering a DOM inside the test that cares is
 * already too late. Two such answers matter here:
 *
 *   `@base-ui/utils/useIsoLayoutEffect` picks `useLayoutEffect` when
 *   `document` is defined and a no-op when it is not. A menu with no layout
 *   effects never wires its trigger to its store, so a test that CLICKS one
 *   (right-panel.chooser.test.tsx) finds a dead button.
 *
 *   `react-dom` sets `canUseDOM` at module scope and derives its whole feature
 *   table from it — passive listeners, composition events, and
 *   `isInputEventSupported`, which is the one with teeth. With no `window` at
 *   import, that last stays false and React routes every controlled text input
 *   down its IE `onpropertychange` polyfill, which never fires on an `input`
 *   event. `onChange` then cannot run at all: the event reaches React, the
 *   value tracker shows a real mismatch, and the change plugin is simply not
 *   on the path that would read it. That is #732, and it read as a Happy DOM
 *   gap because the static `import` of `react-dom/client` in a test file is
 *   hoisted ABOVE that file's own `GlobalRegistrator.register()` call.
 *
 * WHY NOT JUST GIVE THE WHOLE SUITE A DOM. Because most of it is written for a
 * world with no `window`: the storage helpers test their no-window branches,
 * the render tests take `window` away on purpose, and the clipboard shim tests
 * build their own. Measured: 109 of them fail under a permanent DOM.
 *
 * SO: register one, import the modules whose answers freeze, and hand the
 * globals straight back. What they keep is a feature table, not a reference to
 * this throwaway window, so it stays right for the real DOM each test file
 * registers later. Every test file after this sees exactly the environment it
 * was written for.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const hadDocument = typeof document !== "undefined";
if (!hadDocument) {
  GlobalRegistrator.register({ url: "http://localhost/" });
}
// The menu primitive, because pulling it in is what pulls in the module whose
// answer freezes (`@base-ui/utils/useIsoLayoutEffect`, not a dependency of this
// workspace and so not importable by name from here).
await import("@base-ui/react/menu");
// React's own feature detection, for the reason above. `react-dom/client` is
// the entry the render tests use, and importing it is what runs the detection.
await import("react-dom/client");
if (!hadDocument) {
  await GlobalRegistrator.unregister();
}
