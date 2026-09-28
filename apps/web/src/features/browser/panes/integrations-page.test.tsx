// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { confirmProfileDeletion, describeProfileUse, profileNameProblem, whyUndeletable, type BrowserProfile } from "../desktop-browser-profiles";
import { buttonLabelled, click, flush, mount, installTestDom } from "@/test/dom";
import { typeInto } from "@/test/type-into";
import { NewBrowserProfileDialog } from "../settings";
import { BrowserProfilesSection } from "./browser-profiles-section";
import { IntegrationsPage } from "./integrations-page";
import { Row } from "@/features/settings/components/settings-shell";

installTestDom();

afterEach(() => {
  delete (window as { telarDesktop?: unknown }).telarDesktop;
});

function profile(patch: Partial<BrowserProfile> = {}): BrowserProfile {
  return { id: "bp_0123456789abcdef", label: "Work", partition: "persist:telar-profile-bp_0123456789abcdef", createdAt: 1, ...patch };
}

async function mountSection(profiles: BrowserProfile[], bridge: Record<string, unknown> = {}) {
  (window as { telarDesktop?: unknown }).telarDesktop = { browser: { profiles: async () => ({ profiles }), ...bridge } };
  const { host } = await mount(<BrowserProfilesSection />);
  await flush(() => Boolean(host.querySelector(`[aria-label="Icon for ${profiles[0]!.label}"]`)));
  return host;
}


test("the default's row says what a reader cannot see from the list", () => {
  expect(describeProfileUse(profile({ isDefault: true }))).toBe("Every project that has not picked a profile browses here.");
  expect(describeProfileUse(profile({ isDefault: true, projects: ["project_a"] }))).toContain("1 project is assigned to it");
  expect(describeProfileUse(profile({ projects: ["project_a", "project_b"] }))).toBe("2 projects are assigned to it.");
  expect(describeProfileUse(profile())).toContain("Nothing is using it");
});

test("delete is refused for the default alone, and the confirm names what moves", () => {
  expect(whyUndeletable(profile({ isDefault: true }))).toContain("Make another profile the default first");
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
  expect(profileNameProblem("   ", [])).toBe("Give the profile a name.");
  expect(profileNameProblem("Work", [profile()])).toContain("already a profile called");
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

test("a shell without a delete handler offers no Delete button", async () => {
  const host = await mountSection([profile()], { updateProfile: async () => ({ profiles: [] }) });
  expect(host.textContent).toContain("Work");
  expect(buttonLabelled("Delete", host)).toBeUndefined();
});

test("the create prompt refuses an empty or repeated name, and says the account is not checked", async () => {
  const created: unknown[] = [];
  (window as { telarDesktop?: unknown }).telarDesktop = {
    browser: { createProfile: async (input: unknown) => (created.push(input), { profiles: [], active: profile() }) },
  };
  await mount(<NewBrowserProfileDialog open onOpenChange={() => {}} existing={[profile()]} />);
  await flush(() => Boolean(buttonLabelled("Create profile")));
  const create = buttonLabelled("Create profile")!;
  expect(create.disabled).toBe(true);
  expect(document.body.textContent).toContain("A reminder, not a check.");

  await typeInto(document.querySelector('input[name="label"]') as HTMLInputElement, "Work");
  expect(create.disabled).toBe(false);
  await click(create);
  expect(document.body.textContent).toContain("already a profile called");
  expect(created).toEqual([]);
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

test("a profile named Default does not also wear a Default badge; one named otherwise does", async () => {
  const named = await mountSection([profile({ id: "bp_a", label: "Default", isDefault: true })]);
  expect(named.querySelectorAll('[data-slot="badge"]')).toHaveLength(0);

  const other = await mountSection([profile({ id: "bp_b", label: "Work", isDefault: true })]);
  expect([...other.querySelectorAll('[data-slot="badge"]')].map((badge) => badge.textContent)).toEqual(["Default"]);
});
