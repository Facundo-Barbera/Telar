/**
 * HOW LONG A CONVERSATION TAKES TO OPEN, MEASURED RATHER THAN GUESSED (#407).
 *
 * "Switching conversations feels slow" is four different complaints wearing one
 * sentence — the click that does nothing for a moment, the route that arrives
 * with no transcript, the transcript that arrives without the panel — and they
 * have different fixes. So the opening is cut into three spans anybody can read
 * off a running build:
 *
 *   click → commit        the router's own round trip: from the press to the
 *                         moment this cockpit renders the new address at all.
 *   commit → transcript    the first read: from that render to the first paint
 *                         of the conversation's own rows.
 *   transcript → idle      everything else the screen wanted before it settled.
 *
 * WHERE THE CLICK COMES FROM. A capture-phase listener on the document, not a
 * handler wired into the rail: the rail is somebody else's file, the same press
 * happens from a breadcrumb and from the composer's own links, and a
 * measurement that only sees one of them measures the wrong population. It
 * watches for an anchor whose href is a conversation or a canvas, which is
 * exactly the navigation this issue is about.
 *
 * NOTHING IS SENT ANYWHERE. The four stamps go to `performance.mark`, so they
 * appear in a DevTools timeline in any build including a packaged one; the
 * spans are kept in a small ring and printed to the console in development.
 * `window.telarNavTimings()` reads the ring out of a packaged build, which is
 * the route a nightly can be measured through without this file gaining a
 * network call of its own.
 */

/** The four stamps, in the order they happen. */
export type NavPhase = "click" | "commit" | "transcript" | "idle";

/** What put the reader on the road: a press, or the address changing under
 *  them (a back button, a redirect, the first load). Never averaged together —
 *  they are different measurements of different things. */
export type NavStart = "click" | "route";

export type NavTiming = {
  /** Where the reader was going — a pathname, never a title. */
  href: string;
  /** `click` when a press started it, `route` when the address changed under
   *  us (a back button, a redirect, the first load). The two are not the same
   *  measurement and must not be averaged together. */
  from: NavStart;
  startedAt: number;
  /** Milliseconds from the start stamp. Absent until that phase happened. */
  commit?: number;
  transcript?: number;
  idle?: number;
};

/** How many openings to remember. Small: this is a debugging aid on a hot
 *  path, and an unbounded log on a surface people leave open all day is a
 *  leak with a nice name. */
const KEPT = 24;

const timings: NavTiming[] = [];
let current: NavTiming | undefined;
let listening = false;

const now = (): number => (typeof performance === "undefined" ? Date.now() : performance.now());

/** Session and canvas addresses, with or without a `/hosts/:id` prefix — the
 *  two navigations #407 is about, and nothing else. */
function isConversationHref(pathname: string): boolean {
  return /^(?:\/hosts\/[^/]+)?\/projects\/[^/]+\/sessions\/(?:new|[^/]+)\/?$/.test(pathname);
}

function mark(name: string): void {
  try {
    performance.mark(name);
  } catch {
    // A browser without the User Timing API still gets the console spans
    // below; losing the DevTools stamps is not worth an exception on a click.
  }
}

/**
 * A navigation has begun. Idempotent per destination: two presses on the same
 * row are one opening, and the SECOND is the one whose timing means anything
 * (the first may already have painted).
 */
export function startNavigation(href: string, from: NavStart = "route"): void {
  if (current && current.href === href && current.idle === undefined) return;
  current = { href, from, startedAt: now() };
  timings.push(current);
  if (timings.length > KEPT) timings.shift();
  mark(`telar:nav:${from}`);
}

/**
 * One phase of the opening arrived.
 *
 * SILENT WHEN NOTHING STARTED IT, and that is deliberate: a cockpit re-rendering
 * for its own reasons — a delta, a panel opening — must not invent an opening
 * that nobody navigated to, or the numbers stop being about switching at all.
 * Each phase records ONCE per navigation, so "first transcript paint" means the
 * first.
 */
export function markNavigation(phase: Exclude<NavPhase, "click">, href: string): void {
  if (!current || current.href !== href || current[phase] !== undefined) return;
  current[phase] = Math.round((now() - current.startedAt) * 10) / 10;
  mark(`telar:nav:${phase}`);
  if (phase === "idle") report(current);
}

function report(timing: NavTiming): void {
  if (process.env.NODE_ENV === "production") return;
  const span = (value: number | undefined) => (value === undefined ? "—" : `${value}ms`);
  console.info(
    `[telar] opened ${timing.href} — commit ${span(timing.commit)} · transcript ${span(timing.transcript)} · idle ${span(timing.idle)} (from ${timing.from})`,
  );
}

/** Every opening this tab has measured, oldest first. Copied, so a reader
 *  poking at it from a console cannot corrupt the ring. */
export function navigationTimings(): NavTiming[] {
  return timings.map((timing) => ({ ...timing }));
}

/**
 * Watch for presses that open a conversation.
 *
 * CAPTURE PHASE, so the stamp lands before any handler that might call
 * `preventDefault` and before the router starts work — the point being measured
 * is the press itself. Modified clicks (a new window, a download) are left
 * alone: they are not this navigation.
 *
 * Idempotent, and returns nothing to undo: one listener per document for the
 * life of the tab is the whole cost, and a cockpit that unmounted mid-switch
 * would otherwise take the measurement of that very switch with it.
 */
export function installNavigationMarks(): void {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank") return;
      let pathname: string;
      try {
        const url = new URL(anchor.href, window.location.href);
        if (url.origin !== window.location.origin) return;
        pathname = url.pathname;
      } catch {
        return;
      }
      if (!isConversationHref(pathname) || pathname === window.location.pathname) return;
      startNavigation(pathname, "click");
    },
    true,
  );
  const reader = window as typeof window & { telarNavTimings?: () => NavTiming[] };
  reader.telarNavTimings = navigationTimings;
}
