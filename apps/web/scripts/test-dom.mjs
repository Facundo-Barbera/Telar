/**
 * A DOM, for exactly as long as Base UI needs to see one.
 *
 * THE PROBLEM. `@base-ui/utils/useIsoLayoutEffect` decides ONCE, at import,
 * whether its layout effects exist: `useLayoutEffect` when `document` is
 * defined, a no-op when it is not. The suite shares a process, so the first
 * file to pull in a menu freezes that choice for every file after it — and a
 * menu with no layout effects never wires its trigger to its store, so a test
 * that CLICKS one (right-panel.chooser.test.tsx) finds a dead button whenever
 * some other file rendered a primitive first. Registering a DOM from inside
 * that test file is already too late.
 *
 * WHY NOT JUST GIVE THE WHOLE SUITE A DOM. Because most of it is written for a
 * world with no `window`: the storage helpers test their no-window branches,
 * the render tests take `window` away on purpose, and the clipboard shim tests
 * build their own. Measured: 109 of them fail under a permanent DOM.
 *
 * SO: register one, import the module whose answer is frozen, and hand the
 * globals straight back. Base UI keeps `useLayoutEffect`; every test file after
 * this sees exactly the environment it was written for, and the one file that
 * wants a DOM registers its own.
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
if (!hadDocument) {
  await GlobalRegistrator.unregister();
}
