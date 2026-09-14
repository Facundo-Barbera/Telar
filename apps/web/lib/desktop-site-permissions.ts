/**
 * SITE PERMISSIONS, as the cockpit sees them — what one origin may do inside one
 * browser profile, the question the shell is waiting on, and the words all three
 * surfaces print (the prompt over the address bar, the lock popover, and
 * Settings ▸ Browser).
 *
 * A LOCAL STRUCTURAL TYPE AND AN ACCESSOR, like `desktop-browser-profiles.ts` and
 * for the same reason: the shell owns the store (apps/desktop/site-permissions.js),
 * there is no engine route behind any of it, and in a browser tab served to a phone
 * the bridge is never there at all.
 *
 * THE SENTENCES ARE PURE AND EXPORTED. What a prompt says a site is asking for, and
 * what a row says a site holds, is the part a person acts on — so it is testable
 * without mounting a shell, and it is said the same way in all three places.
 */

/** The closed vocabulary, the same list the shell will store (#422). */
export const PERMISSION_KINDS = ["camera", "microphone", "notifications", "geolocation", "clipboard-read", "display-capture"] as const;
export type SitePermissionKind = (typeof PERMISSION_KINDS)[number];
export type SitePermissionDecision = "allow" | "block";

/** One remembered answer, with when it was given. */
export type SitePermissionRecord = { kind: SitePermissionKind; decision: SitePermissionDecision; at: number };
export type SitePermissionOrigin = { origin: string; kinds: SitePermissionRecord[] };
/** Every decision one profile holds. `profileId` is null for a jar whose profile
 *  record is gone — listed under its partition anyway, because a decision you
 *  cannot see is a decision you cannot revoke. */
export type SitePermissionProfile = { partition: string; profileId: string | null; label: string; origins: SitePermissionOrigin[] };

/** A screen or a window the person may share. `thumbnail` is a data URL the
 *  shell rendered; null when this Mac would not give one. */
export type PermissionPromptSource = { id: string; name: string; kind: "screen" | "window"; thumbnail: string | null };

/**
 * A QUESTION THE BROWSER IS WAITING ON. `sources` is present only for a screen
 * share, where the picker IS the prompt. The shell times it out to Block after a
 * minute, so nothing here has to own a deadline.
 */
export type PermissionPrompt = {
  requestId: string;
  scopeKey: string | null;
  tabId: string | null;
  partition: string | null;
  origin: string;
  kinds: SitePermissionKind[];
  askedAt: number;
  sources?: PermissionPromptSource[];
};

/** macOS refused the device AFTER the human allowed the site. The page will only
 *  ever say NotAllowedError; this is the sentence that names the pane to open. */
export type PermissionDenial = { origin: string; kinds: SitePermissionKind[]; reason: string };

export type SitePermissionsBridge = {
  onPermissionRequest?(listener: (prompt: PermissionPrompt) => void): () => void;
  onPermissionDenied?(listener: (denial: PermissionDenial) => void): () => void;
  answerPermission?(input: { requestId: string; decision: "allow" | "once" | "block"; sourceId?: string }): Promise<{ answered: boolean }>;
  permissionPrompts?(scopeKey?: string): Promise<{ prompts: PermissionPrompt[] }>;
  /** With a `scopeKey` and an `origin`: what that site holds here. With a scope
   *  alone: every site this session's profile has an answer for. With neither:
   *  every profile's, for Settings. */
  sitePermissions?(input: { scopeKey?: string; origin?: string }): Promise<
    | { partition: string; origin: string; kinds: SitePermissionRecord[] }
    | { partition: string; origins: SitePermissionOrigin[] }
    | { kinds: SitePermissionKind[]; profiles: SitePermissionProfile[] }
  >;
  /** Take one back — one kind, or (with no `kind`) an origin's whole row. */
  forgetSitePermission?(input: { partition?: string; scopeKey?: string; origin: string; kind?: SitePermissionKind }): Promise<{
    kinds: SitePermissionKind[];
    profiles: SitePermissionProfile[];
  }>;
};

export function desktopSitePermissions(): SitePermissionsBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { telarDesktop?: { browser?: SitePermissionsBridge } }).telarDesktop?.browser;
}

/** The word each kind goes by, everywhere. Deliberately the page's vocabulary
 *  ("location", not "geolocation") — it is what a person is being asked about. */
export const PERMISSION_KIND_WORDS: Record<SitePermissionKind, string> = {
  camera: "camera",
  microphone: "microphone",
  notifications: "notifications",
  geolocation: "location",
  "clipboard-read": "clipboard",
  "display-capture": "screen",
};

/** The same words with a capital, for a row that starts a line. */
export const PERMISSION_KIND_TITLES: Record<SitePermissionKind, string> = {
  camera: "Camera",
  microphone: "Microphone",
  notifications: "Notifications",
  geolocation: "Location",
  "clipboard-read": "Clipboard",
  "display-capture": "Screen sharing",
};

export function isPermissionKind(value: string): value is SitePermissionKind {
  return (PERMISSION_KINDS as readonly string[]).includes(value);
}

/** "camera and microphone" — the phrase a prompt puts after the site's name. */
export function describePermissionKinds(kinds: readonly SitePermissionKind[]): string {
  const words = kinds.map((kind) => PERMISSION_KIND_WORDS[kind] ?? kind);
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * THE SITE, AS A PERSON READS IT. An origin's scheme is noise on the line that
 * names who is asking — except when it is not https, which is the one thing about
 * the scheme worth a person's attention, so a plain-http site keeps its `http://`
 * rather than passing for a secure one.
 */
export function siteLabel(origin: string): string {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "https:" ? parsed.host : `${parsed.protocol}//${parsed.host}`;
  } catch {
    return origin;
  }
}

/** The prompt's one sentence. Screen sharing asks a different question — "which
 *  screen", not "may I" — so it says so. */
export function permissionPromptTitle(prompt: Pick<PermissionPrompt, "origin" | "kinds">): string {
  if (prompt.kinds.length === 1 && prompt.kinds[0] === "display-capture") {
    return `${siteLabel(prompt.origin)} wants to share your screen`;
  }
  return `${siteLabel(prompt.origin)} wants to use your ${describePermissionKinds(prompt.kinds)}`;
}

/** What a remembered row says, in the words of the decision that made it. */
export function describeSitePermission(record: SitePermissionRecord): string {
  return `${PERMISSION_KIND_TITLES[record.kind] ?? record.kind} — ${record.decision === "allow" ? "allowed" : "blocked"}`;
}

/**
 * WHAT THE LOCK ICON SAYS ABOUT A PAGE, in one sentence. The three states are
 * genuinely different and a reader acts differently on each: nothing decided (the
 * ordinary case, and the popover is then only a place to look), something allowed,
 * something refused.
 */
export function describeSiteStanding(origin: string, records: readonly SitePermissionRecord[]): string {
  if (!records.length) return `${siteLabel(origin)} has not asked for anything.`;
  const allowed = records.filter((record) => record.decision === "allow").map((record) => PERMISSION_KIND_WORDS[record.kind]);
  const blocked = records.filter((record) => record.decision === "block").map((record) => PERMISSION_KIND_WORDS[record.kind]);
  const parts: string[] = [];
  if (allowed.length) parts.push(`can use your ${describeList(allowed)}`);
  if (blocked.length) parts.push(`is blocked from your ${describeList(blocked)}`);
  return `${siteLabel(origin)} ${parts.join(", and ")}.`;
}

function describeList(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}
