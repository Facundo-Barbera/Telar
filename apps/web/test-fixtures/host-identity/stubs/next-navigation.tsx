/**
 * `next/navigation`, for a fixture that mounts a real cockpit component
 * outside Next. The router is a recorder and the pathname is settable, which
 * is the whole point: the defect under test is a component that resolves a
 * host from the address bar, so the address bar has to be a control.
 */
import { useEffect, useState } from "react";

type Listener = (pathname: string) => void;

let pathname = "/";
const listeners = new Set<Listener>();
/** Every navigation the component asked for, newest last. */
export const pushed: string[] = [];

/**
 * Move the address — and move the REAL one too, with `history.pushState`.
 *
 * Both halves matter. `usePathname` is what the component reads for its links,
 * but `pathnameFetcher` reads `window.location.pathname` when it builds each
 * request URL (lib/hosts/client.ts:65), so a fixture that only moved the hook
 * would leave every request pointing at the fixture's own address and could not
 * see the defect at all. `pushState` never fetches, so no page load happens.
 */
export function setFixturePathname(next: string): void {
  pathname = next;
  if (typeof window !== "undefined") window.history.pushState(null, "", next);
  for (const listener of listeners) listener(next);
}

export function fixturePathname(): string {
  return pathname;
}

export function usePathname(): string {
  const [value, setValue] = useState(pathname);
  useEffect(() => {
    const listener: Listener = (next) => setValue(next);
    listeners.add(listener);
    // A cleanup returns void: `Set.delete` answers a boolean, which React
    // would read as a destructor it cannot call.
    return () => {
      listeners.delete(listener);
    };
  }, []);
  // Adjusted during render rather than from the effect: the address may have
  // moved between this hook's mount and its subscription, and a setState in an
  // effect body is a cascading render.
  if (value !== pathname) setValue(pathname);
  return value;
}

/** A router that records instead of navigating — following the link is the
 *  fixture's decision, so a click cannot smuggle in a real page load. */
export function useRouter() {
  return {
    push: (href: string) => {
      pushed.push(href);
      setFixturePathname(href);
    },
    replace: (href: string) => {
      pushed.push(href);
      setFixturePathname(href);
    },
    back: () => undefined,
    forward: () => undefined,
    refresh: () => undefined,
    prefetch: () => undefined,
  };
}

export function useSearchParams(): URLSearchParams {
  return new URLSearchParams();
}

export function useParams(): Record<string, string> {
  return {};
}

export function redirect(): never {
  throw new Error("redirect is not available in the fixture");
}

export function notFound(): never {
  throw new Error("notFound is not available in the fixture");
}
