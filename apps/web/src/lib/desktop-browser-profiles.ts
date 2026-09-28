/** Browser profiles as the cockpit sees them; the shell owns the registry (apps/desktop/browser-profiles.js). */
import type { IdentityColor, TelarIcon } from "@telar/engine-client";

/** One identity. `projects` and `isDefault` are computed by the shell per read. */
export type BrowserProfile = {
  id: string;
  label: string;
  partition: string;
  createdAt: number;
  /** The account this profile is meant to be signed into; nothing verifies it. */
  account?: string;
  /**
   * Typed as `string` because they arrive from the shell's JSON: an unknown icon
   * still parses, and `telarIconGlyph` falls back rather than throwing.
   */
  icon?: TelarIcon | string;
  color?: IdentityColor | string;
  isDefault?: boolean;
  /** Explicit assignments only; projects using it as the default are not listed. */
  projects?: string[];
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
  /** A patch: an absent key leaves the stored value alone, and `null` removes a mark. */
  updateProfile: (input: { profileId: string; label?: string; account?: string; icon?: string | null; color?: string | null }) => Promise<{ profiles: BrowserProfile[] }>;
  setDefaultProfile: (profileId: string) => Promise<{ profiles: BrowserProfile[] }>;
  /** Absent on an older shell, where the pane hides the control. */
  deleteProfile?: (profileId: string) => Promise<{ profiles: BrowserProfile[] }>;
};

export function desktopBrowserProfiles(): BrowserProfilesBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { telarDesktop?: { browser?: BrowserProfilesBridge } }).telarDesktop?.browser;
}

/** The sentence under a profile's name: who browses here. */
export function describeProfileUse(profile: BrowserProfile): string {
  const assigned = profile.projects?.length ?? 0;
  const shared = assigned === 1 ? "1 project is assigned to it" : `${assigned} projects are assigned to it`;
  if (profile.isDefault) {
    return assigned ? `Every project that has not picked a profile browses here, and ${shared}.` : "Every project that has not picked a profile browses here.";
  }
  if (!assigned) return "Nothing is using it. Sessions can still switch to it by hand.";
  return `${shared[0].toUpperCase()}${shared.slice(1)}.`;
}

/** Why delete is unavailable, or undefined when it is. */
export function whyUndeletable(profile: BrowserProfile): string | undefined {
  if (profile.isDefault) return "The default profile cannot be deleted. Make another profile the default first.";
  return undefined;
}

/** The confirm text, naming how many projects move and where they move to. */
export function confirmProfileDeletion(profile: BrowserProfile, profiles: BrowserProfile[]): string {
  const assigned = profile.projects?.length ?? 0;
  const fallback = profiles.find((candidate) => candidate.isDefault)?.label;
  const moved = assigned
    ? ` ${assigned === 1 ? "1 project" : `${assigned} projects`} will use ${fallback ? `"${fallback}"` : "the default"} instead.`
    : "";
  return `Delete "${profile.label}"?${moved} Sessions browsing in it move over, and its open tabs reload signed out. Its cookies stay on disk.`;
}

/** A non-empty, case-insensitively unique name, or the problem with it. */
export function profileNameProblem(label: string, existing: BrowserProfile[], ignoreId?: string): string | undefined {
  const name = label.trim().replace(/\s+/g, " ");
  if (!name) return "Give the profile a name.";
  if (existing.some((profile) => profile.id !== ignoreId && profile.label.toLowerCase() === name.toLowerCase())) {
    return `There is already a profile called “${name}”.`;
  }
  return undefined;
}
