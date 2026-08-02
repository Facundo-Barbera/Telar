export const TELAR_REFRESH_EVENT = "telar:refresh";

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

/** Legacy plain events intentionally invalidate every domain. New callers can
 * scope high-frequency mutations without breaking older surfaces. */
export function refreshIncludes(event: Event, domain: TelarRefreshDomain): boolean {
  const detail = (event as CustomEvent<TelarRefreshDetail | undefined>).detail;
  return !detail?.domains || detail.domains.includes(domain);
}
