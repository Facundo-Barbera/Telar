
export const PERMISSION_KINDS = ["camera", "microphone", "notifications", "geolocation", "clipboard-read", "display-capture"] as const;
export type SitePermissionKind = (typeof PERMISSION_KINDS)[number];
type SitePermissionDecision = "allow" | "block";

export type SitePermissionRecord = { kind: SitePermissionKind; decision: SitePermissionDecision; at: number };
type SitePermissionOrigin = { origin: string; kinds: SitePermissionRecord[] };
export type SitePermissionProfile = { partition: string; profileId: string | null; label: string; origins: SitePermissionOrigin[] };

export type PermissionPromptSource = { id: string; name: string; kind: "screen" | "window"; thumbnail: string | null };

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

type PermissionDenial = { origin: string; kinds: SitePermissionKind[]; reason: string };

export type SitePermissionsBridge = {
  onPermissionRequest?(listener: (prompt: PermissionPrompt) => void): () => void;
  onPermissionDenied?(listener: (denial: PermissionDenial) => void): () => void;
  answerPermission?(input: { requestId: string; decision: "allow" | "once" | "block"; sourceId?: string }): Promise<{ answered: boolean }>;
  permissionPrompts?(scopeKey?: string): Promise<{ prompts: PermissionPrompt[] }>;
  sitePermissions?(input: { scopeKey?: string; origin?: string }): Promise<
    | { partition: string; origin: string; kinds: SitePermissionRecord[] }
    | { partition: string; origins: SitePermissionOrigin[] }
    | { kinds: SitePermissionKind[]; profiles: SitePermissionProfile[] }
  >;
  forgetSitePermission?(input: { partition?: string; scopeKey?: string; origin: string; kind?: SitePermissionKind }): Promise<{
    kinds: SitePermissionKind[];
    profiles: SitePermissionProfile[];
  }>;
};

export function desktopSitePermissions(): SitePermissionsBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { telarDesktop?: { browser?: SitePermissionsBridge } }).telarDesktop?.browser;
}

const PERMISSION_KIND_WORDS: Record<SitePermissionKind, string> = {
  camera: "camera",
  microphone: "microphone",
  notifications: "notifications",
  geolocation: "location",
  "clipboard-read": "clipboard",
  "display-capture": "screen",
};

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

export function describePermissionKinds(kinds: readonly SitePermissionKind[]): string {
  const words = kinds.map((kind) => PERMISSION_KIND_WORDS[kind] ?? kind);
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

export function siteLabel(origin: string): string {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "https:" ? parsed.host : `${parsed.protocol}//${parsed.host}`;
  } catch {
    return origin;
  }
}

export function permissionPromptTitle(prompt: Pick<PermissionPrompt, "origin" | "kinds">): string {
  if (prompt.kinds.length === 1 && prompt.kinds[0] === "display-capture") {
    return `${siteLabel(prompt.origin)} wants to share your screen`;
  }
  return `${siteLabel(prompt.origin)} wants to use your ${describePermissionKinds(prompt.kinds)}`;
}

export function describeSitePermission(record: SitePermissionRecord): string {
  return `${PERMISSION_KIND_TITLES[record.kind] ?? record.kind} — ${record.decision === "allow" ? "allowed" : "blocked"}`;
}

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
