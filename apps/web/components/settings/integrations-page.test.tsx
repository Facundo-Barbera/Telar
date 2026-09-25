// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { confirmProfileDeletion, describeProfileUse, profileNameProblem, whyUndeletable, type BrowserProfile } from "@/lib/desktop-browser-profiles";
import { BrowserProfilesSection } from "./browser-profiles-section";
import { IntegrationsPage } from "./integrations-page";
import { Row } from "./settings-shell";

/**
 * THE INTEGRATIONS PANE: the sentences a reader acts on, and the two refusals.
 *
 * The sections fetch on mount, so what is pinned here is the COPY and the
 * branch structure — the same approach agent-tools.test.tsx takes, and for the
 * same reason: a row that says a profile is unused when a project is assigned to
 * it is a correctness bug, not a layout preference.
 */
const section = readFileSync(new URL("./browser-profiles-section.tsx", import.meta.url), "utf8");
const prompt = readFileSync(new URL("../browser-profile-prompt.tsx", import.meta.url), "utf8");

function profile(patch: Partial<BrowserProfile> = {}): BrowserProfile {
  return { id: "bp_0123456789abcdef", label: "Work", partition: "persist:telar-profile-bp_0123456789abcdef", createdAt: 1, ...patch };
}

test("the default's row says what a reader cannot see from the list", () => {
  // Projects that never picked a profile leave no mark on any row, so without
  // this sentence the default looks unused and deleting it looks harmless.
  expect(describeProfileUse(profile({ isDefault: true }))).toBe("Every project that has not picked a profile browses here.");
  expect(describeProfileUse(profile({ isDefault: true, projects: ["project_a"] }))).toContain("1 project is assigned to it");
  expect(describeProfileUse(profile({ projects: ["project_a", "project_b"] }))).toBe("2 projects are assigned to it.");
  expect(describeProfileUse(profile())).toContain("Nothing is using it");
});

test("delete is refused for the default alone, and the confirm names what moves (#476)", () => {
  expect(whyUndeletable(profile({ isDefault: true }))).toContain("Make another profile the default first");
  // A profile projects are assigned to is deletable: they fall back to the
  // default with it, which the confirm says before it happens rather than the
  // row saying "point them elsewhere first".
  expect(whyUndeletable(profile({ projects: ["project_a"] }))).toBeUndefined();
  expect(whyUndeletable(profile())).toBeUndefined();

  const fallback = profile({ id: "bp_default", label: "Default", isDefault: true });
  expect(confirmProfileDeletion(profile({ projects: ["project_a", "project_b"] }), [fallback])).toBe(
    'Delete "Work"? 2 projects will use "Default" instead. Sessions browsing in it move over, and its open tabs reload signed out. Its cookies stay on disk.',
  );
  expect(confirmProfileDeletion(profile({ projects: ["project_a"] }), [fallback])).toContain("1 project will use");
  expect(confirmProfileDeletion(profile(), [fallback])).toBe('Delete "Work"? Sessions browsing in it move over, and its open tabs reload signed out. Its cookies stay on disk.');
});

test("a profile name is required and may not repeat another", () => {
  // The registry no longer invents names; this is the form that makes "required"
  // true rather than intended.
  expect(profileNameProblem("   ", [])).toBe("Give the profile a name.");
  expect(profileNameProblem("Work", [profile()])).toContain("already a profile called");
  // Renaming a profile to its own name is not a duplicate.
  expect(profileNameProblem("Work", [profile()], "bp_0123456789abcdef")).toBeUndefined();
  expect(profileNameProblem("Personal", [profile()])).toBeUndefined();
});

test("a browser tab says it has no browser host rather than offering dead controls", () => {
  const html = renderToStaticMarkup(<BrowserProfilesSection />);
  expect(html).toContain("Desktop app only");
  expect(html).toContain("no browser host");
  expect(html).not.toContain("New profile");
});

test("the pane is profiles THEN remembered logins — a grant is scoped to a profile", () => {
  const html = renderToStaticMarkup(<IntegrationsPage />);
  expect(html.indexOf("Browser profiles")).toBeGreaterThan(-1);
  expect(html.indexOf("Browser profiles")).toBeLessThan(html.indexOf("Remembered logins"));
});

test("the delete button is disabled by the same rule that explains it, and asks first", () => {
  // One source of truth: whatever whyUndeletable says is both the tooltip and
  // the disabled condition, so a button is never live with a reason attached.
  expect(section).toContain("disabled={busy === profile.id || Boolean(whyUndeletable(profile))}");
  expect(section).toContain("title={whyUndeletable(profile) ??");
  // Nothing is forgotten without the question, and the question is the shared
  // sentence rather than one written twice.
  expect(section).toContain("if (!window.confirm(confirmProfileDeletion(profile, profiles ?? []))) return;");
  // And it is hidden entirely on a shell too old to have the handler.
  expect(section).toContain("{bridge.deleteProfile && (");
});

test("the create prompt refuses to submit an empty name", () => {
  expect(prompt).toContain("disabled={busy || !label.trim()}");
  expect(prompt).toContain("profileNameProblem(label, existing)");
  // The expected account is stated as a note, never as a check.
  expect(prompt).toContain("A reminder, not a check.");
});

test("a row renders the name, the default badge and the account", () => {
  const html = renderToStaticMarkup(
    <Row
      label={
        <span>
          <span>Work</span>
          <span>Default</span>
          <span>me@work.example</span>
        </span>
      }
      hint={describeProfileUse(profile({ isDefault: true, account: "me@work.example" }))}
    />,
  );
  expect(html).toContain("Work");
  expect(html).toContain("me@work.example");
  expect(html).toContain("browses here");
});

test("a profile named Default does not also wear a Default badge", () => {
  // It read "Default Default" (#357): a badge repeating the name beside it adds
  // no fact. One named anything else still needs the mark.
  expect(section).toContain('profile.label.trim().toLowerCase() !== "default"');
});
