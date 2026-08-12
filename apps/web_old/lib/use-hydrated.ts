"use client";

// "Has this tree finished hydrating?" — false during SSR and during the first
// client render, true from the commit after hydration onward.
//
// WHY THIS EXISTS, concretely. The host app Telar runs inside (cmux) stamps a
// `data-cmux-addressbar-focus-id` attribute onto the composer's <textarea>
// between HTML parse and React hydration, with a fresh random id per page load.
// React then compares its client render against a DOM that carries an attribute
// no render produced, and reports a hydration mismatch on every load. Measured:
// that attribute was the ONLY difference reported.
//
// The tempting answer is `suppressHydrationWarning`, and it is the wrong one:
// it does not stop the mismatch, it stops the REPORT — and it would blind that
// element to real mismatches forever after, including ones we cause. The actual
// fix is to stop shipping a server-rendered <textarea> for a third party to
// stamp: gate it on this hook, render an inert same-height placeholder until
// hydration finishes, and let React create the real control CLIENT-SIDE, after
// hydration, where nothing is being compared. cmux stamps it a moment later and
// there is no diff to report because there is no hydration left to do.
//
// WHY useSyncExternalStore RATHER THAN useState + useEffect. The effect version
// calls setState directly inside an effect, which is a cascading render and is
// flagged as such (react-hooks/set-state-in-effect). This is the same primitive
// with none of that: React uses `getServerSnapshot` for SSR and for the
// hydration render — so both agree on `false`, which is what makes hydration
// clean — then re-renders with `getSnapshot` afterwards.
//
// The store never emits, because nothing ever changes: `hydrated` goes false →
// true exactly once, by way of React switching snapshot functions, not by way
// of a subscription firing.
import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const onClient = () => true;
const onServer = () => false;

export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, onClient, onServer);
}
