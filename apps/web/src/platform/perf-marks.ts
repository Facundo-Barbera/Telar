
export type NavPhase = "click" | "commit" | "transcript" | "idle";

export type NavStart = "click" | "route";

export type NavTiming = {
  href: string;
  from: NavStart;
  startedAt: number;
  commit?: number;
  transcript?: number;
  idle?: number;
};

const KEPT = 24;

const timings: NavTiming[] = [];
let current: NavTiming | undefined;
let listening = false;

const now = (): number => (typeof performance === "undefined" ? Date.now() : performance.now());

function isConversationHref(pathname: string): boolean {
  return /^(?:\/hosts\/[^/]+)?\/projects\/[^/]+\/sessions\/(?:new|[^/]+)\/?$/.test(pathname);
}

function isSettingsHref(pathname: string): boolean {
  return pathname === "/settings" || /^\/projects\/[^/]+\/settings(?:\/|$)/.test(pathname);
}

export function isMeasuredHref(pathname: string): boolean {
  return isConversationHref(pathname) || isSettingsHref(pathname);
}

function mark(name: string): void {
  try {
    performance.mark(name);
  } catch {
  }
}

export function startNavigation(href: string, from: NavStart = "route"): void {
  if (current && current.href === href && current.idle === undefined) return;
  current = { href, from, startedAt: now() };
  timings.push(current);
  if (timings.length > KEPT) timings.shift();
  mark(`telar:nav:${from}`);
}

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

export function navigationTimings(): NavTiming[] {
  return timings.map((timing) => ({ ...timing }));
}

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
      if (!isMeasuredHref(pathname) || pathname === window.location.pathname) return;
      startNavigation(pathname, "click");
    },
    true,
  );
  const reader = window as typeof window & { telarNavTimings?: () => NavTiming[] };
  reader.telarNavTimings = navigationTimings;
}
