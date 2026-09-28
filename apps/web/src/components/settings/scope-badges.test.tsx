// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentType } from "react";
import { BrowserLoginsSection } from "./browser-logins-section";
import { BrowserProfilesSection } from "./browser-profiles-section";
import { DictationMicrophoneSection } from "./dictation-microphone-section";
import { DictationSection } from "./dictation-section";
import { InboxSection } from "@/features/sessions/components/inbox-section";
import { LinksSection } from "./links-section";
import { SECTIONS } from "./settings-sections";
import { Row, SettingsGroup, ToggleRow } from "./settings-shell";
import { TextGenSection } from "@/features/providers/components/textgen-section";
import { WorkspaceSection } from "@/features/projects";

test("a group's scope renders as a quiet label, with its meaning behind the ⓘ", () => {
  const html = renderToStaticMarkup(
    <SettingsGroup title="Links" scope="browser">
      <Row label="Something" />
    </SettingsGroup>,
  );
  expect(html).toContain('data-scope="browser"');
  expect(html).toContain("This browser");
  expect(html).toContain('aria-label="Scope: This browser"');
  expect(html).toContain("Kept in this window&#x27;s own storage.");
});

test("ToggleRow passes `info` through to Row's ⓘ", () => {
  const html = renderToStaticMarkup(<ToggleRow label="A switch" info="The fact nobody could infer." checked onCheckedChange={() => {}} />);
  expect(html).toContain('data-info="The fact nobody could infer."');
});

test("panes that share one scope say it once, in the nav", () => {
  expect(Object.fromEntries(SECTIONS.map((section) => [section.id, section.scope]))).toEqual({
    general: undefined,
    appearance: "browser",
    keybindings: "browser",
    integrations: undefined,
    dictation: undefined,
    providers: "mac",
    tools: "mac",
    plugins: "mac",
    projects: "project",
    remote: "mac",
    storage: "mac",
    about: "mac",
    updates: "mac",
    "source-control": "mac",
  });
});

test("the mixed panes mark each group by where it is stored", () => {
  const scopes = (Section: ComponentType) => [...new Set([...renderToStaticMarkup(<Section />).matchAll(/data-scope="(\w+)"/g)].map((match) => match[1]))];
  expect(scopes(LinksSection)).toEqual(["browser"]);
  expect(scopes(DictationMicrophoneSection)).toEqual(["browser"]);
  // Off the address bar's host this reads "host"; the local engine is this Mac.
  expect(scopes(InboxSection)).toEqual(["mac"]);
  for (const Section of [WorkspaceSection, TextGenSection, DictationSection, BrowserLoginsSection, BrowserProfilesSection]) {
    expect(scopes(Section)).toEqual(["mac"]);
  }
});
