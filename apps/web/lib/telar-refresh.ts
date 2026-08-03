export const TELAR_REFRESH_EVENT = "telar:refresh";
export const TELAR_SESSION_RUN_EVENT = "telar:session-run";

export type TelarRefreshDomain =
  | "accounts"
  | "chats"
  | "git"
  | "looms"
  | "projects"
  | "ultra"
  | "usage";

export type TelarRefreshDetail = {
  domains: readonly TelarRefreshDomain[];
  project?: string;
  sessionId?: string;
};

export function dispatchTelarRefresh(detail?: TelarRefreshDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    detail
      ? new CustomEvent<TelarRefreshDetail>(TELAR_REFRESH_EVENT, { detail })
      : new Event(TELAR_REFRESH_EVENT),
  );
}

/** Wake lightweight session observers when a turn starts in this browser tab.
 * The event carries identity only; the chat stream remains the source of truth. */
export function dispatchTelarSessionRun(sessionId: string | null | undefined) {
  if (typeof window === "undefined" || !sessionId) return;
  window.dispatchEvent(new CustomEvent<string>(TELAR_SESSION_RUN_EVENT, { detail: sessionId }));
}

/** Legacy plain events intentionally invalidate every domain. New callers can
 * scope high-frequency mutations without breaking older surfaces. */
export function refreshIncludes(event: Event, domain: TelarRefreshDomain): boolean {
  const detail = (event as CustomEvent<TelarRefreshDetail | undefined>).detail;
  return !detail?.domains || detail.domains.includes(domain);
}
