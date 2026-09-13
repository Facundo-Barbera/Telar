/**
 * BROWSER PROFILES, as the cockpit sees them — a named Chromium identity
 * (cookies, storage, extension state) that one or many projects browse in.
 *
 * A LOCAL STRUCTURAL TYPE AND AN ACCESSOR, like `desktop-updates.ts` and for the
 * same reason: the shell owns the registry (apps/desktop/browser-profiles.js),
 * there is no engine route behind any of this, and in a browser tab the bridge is
 * never there at all.
 *
 * THE SENTENCES ARE PURE AND EXPORTED. What a row says about a profile — who uses
 * it, why it cannot be deleted — is the part a reader acts on, so it is testable
 * without mounting a shell.
 */
import type { IdentityColor, TelarIcon } from "@telar/engine-client";

/** One identity. `projects` and `isDefault` are computed by the shell per read. */
export type BrowserProfile = {
  id: string;
  label: string;
  partition: string;
  createdAt: number;
  /** The account this profile is MEANT to be signed into. Intent, not proof —
   *  nothing anywhere verifies a login against it. */
  account?: string;
  /**
   * THE MARKS A PERSON PUT ON IT — a glyph from the app's own closed set and one
   * of eight identity hues. Both optional: an unmarked profile is an ordinary
   * profile, drawn with the neutral ring, and nothing here invents one.
   *
   * These are what let the browser panel show a profile in the width of one
   * glyph. They are typed loosely (`string`) because they arrive from the shell's
   * JSON: a build that knew a fortieth icon this one does not still parses, and
   * `telarIconGlyph` falls back rather than throwing.
   */
  icon?: TelarIcon | string;
  color?: IdentityColor | string;
  isDefault?: boolean;
  /** Project keys explicitly assigned to this profile. A project browsing here
   *  only because it is the default is deliberately NOT listed: it has no
   *  assignment, and changing the default moves it. */
  projects?: string[];
};

export type ProfilesAnswer = {
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
  /** A PATCH: an absent key leaves what is stored alone, and `null` takes a mark
   *  off — so setting a colour never has to resend the icon to keep it. */
  updateProfile: (input: { profileId: string; label?: string; account?: string; icon?: string | null; color?: string | null }) => Promise<{ profiles: BrowserProfile[] }>;
  setDefaultProfile: (profileId: string) => Promise<{ profiles: BrowserProfile[] }>;
  /** Optional: an older shell has no delete, and the pane hides the control
   *  rather than offering a button that throws. */
  deleteProfile?: (profileId: string) => Promise<{ profiles: BrowserProfile[] }>;
};

export function desktopBrowserProfiles(): BrowserProfilesBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { telarDesktop?: { browser?: BrowserProfilesBridge } }).telarDesktop?.browser;
}

/**
 * The sentence under a profile's name: who browses here.
 *
 * THE DEFAULT'S SENTENCE IS ABOUT PROJECTS THAT DID NOT CHOOSE, which is the one
 * thing a reader cannot see from the list — an unassigned project leaves no mark
 * on any row, so without saying it the default looks unused.
 */
export function describeProfileUse(profile: BrowserProfile): string {
  const assigned = profile.projects?.length ?? 0;
  const shared = assigned === 1 ? "1 project is assigned to it" : `${assigned} projects are assigned to it`;
  if (profile.isDefault) {
    return assigned ? `Every project that has not picked a profile browses here, and ${shared}.` : "Every project that has not picked a profile browses here.";
  }
  if (!assigned) return "Nothing is using it. Sessions can still switch to it by hand.";
  return `${shared[0].toUpperCase()}${shared.slice(1)}.`;
}

/** Why delete is unavailable, or undefined when it is. The same two rules the
 *  registry enforces, said before the click rather than after it. */
export function whyUndeletable(profile: BrowserProfile): string | undefined {
  if (profile.isDefault) return "The default profile cannot be deleted. Make another profile the default first.";
  if (profile.projects?.length) return "A project is assigned to it. Point that project at another profile first.";
  return undefined;
}

/**
 * THE NAME IS REQUIRED AND IT IS THE PERSON'S. Nothing generates one: the old
 * registry minted labels like "Project 6f6f07" and they told a reader nothing,
 * so the form refuses to submit an empty field rather than filling it in.
 *
 * A duplicate is refused too — two rows reading "Work" in a list whose whole job
 * is telling identities apart is a list that has stopped working.
 */
export function profileNameProblem(label: string, existing: BrowserProfile[], ignoreId?: string): string | undefined {
  const name = label.trim().replace(/\s+/g, " ");
  if (!name) return "Give the profile a name.";
  if (existing.some((profile) => profile.id !== ignoreId && profile.label.toLowerCase() === name.toLowerCase())) {
    return `There is already a profile called “${name}”.`;
  }
  return undefined;
}
