import type { IdentityColor, TelarIcon } from "@telar/engine-client";

export type BrowserProfile = {
  id: string;
  label: string;
  partition: string;
  createdAt: number;
  account?: string;
  icon?: TelarIcon | string;
  color?: IdentityColor | string;
  isDefault?: boolean;
  projects?: string[];
  sessions?: number;
};

type ProfilesAnswer = {
  profiles: BrowserProfile[];
  active?: BrowserProfile | null;
  projectKey?: string | null;
};

export type BrowserProfilesBridge = {
  profiles: (scopeKey?: string) => Promise<ProfilesAnswer>;
  createProfile: (input: { label: string; account?: string; icon?: string; color?: string; scopeKey?: string; assignProject?: boolean }) => Promise<{
    profiles: BrowserProfile[];
    active: BrowserProfile;
  }>;
  updateProfile: (input: { profileId: string; label?: string; account?: string; icon?: string | null; color?: string | null }) => Promise<{ profiles: BrowserProfile[] }>;
  setDefaultProfile: (profileId: string) => Promise<{ profiles: BrowserProfile[] }>;
  deleteProfile?: (profileId: string) => Promise<{ profiles: BrowserProfile[] }>;
};

export function desktopBrowserProfiles(): BrowserProfilesBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { telarDesktop?: { browser?: BrowserProfilesBridge } }).telarDesktop?.browser;
}

export function describeProfileUse(profile: BrowserProfile): string {
  const assigned = profile.projects?.length ?? 0;
  const shared = assigned === 1 ? "1 project is assigned to it" : `${assigned} projects are assigned to it`;
  if (profile.isDefault) {
    return assigned ? `Every project that has not picked a profile browses here, and ${shared}.` : "Every project that has not picked a profile browses here.";
  }
  if (!assigned) return "Nothing is using it. Sessions can still switch to it by hand.";
  return `${shared[0].toUpperCase()}${shared.slice(1)}.`;
}

export function whyUndeletable(profile: BrowserProfile): string | undefined {
  if (profile.isDefault) return "The default profile cannot be deleted. Make another profile the default first.";
  return undefined;
}

export function confirmProfileDeletion(profile: BrowserProfile, profiles: BrowserProfile[]): string {
  const projects = profile.projects?.length ?? 0;
  const sessions = profile.sessions ?? 0;
  const fallback = profiles.find((candidate) => candidate.isDefault)?.label;
  const users = [
    projects ? (projects === 1 ? "1 project" : `${projects} projects`) : "",
    sessions ? (sessions === 1 ? "1 session" : `${sessions} sessions`) : "",
  ].filter(Boolean);
  const moved = users.length ? ` ${users.join(" and ")} will use ${fallback ? `"${fallback}"` : "the default"} instead.` : "";
  return `Delete "${profile.label}"?${moved} Its cookies and site data are deleted.`;
}

export function profileNameProblem(label: string, existing: BrowserProfile[], ignoreId?: string): string | undefined {
  const name = label.trim().replace(/\s+/g, " ");
  if (!name) return "Give the profile a name.";
  if (existing.some((profile) => profile.id !== ignoreId && profile.label.toLowerCase() === name.toLowerCase())) {
    return `There is already a profile called “${name}”.`;
  }
  return undefined;
}
