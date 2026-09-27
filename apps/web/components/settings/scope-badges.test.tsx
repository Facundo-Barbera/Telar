// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { Row, SettingsGroup, ToggleRow } from "./settings-shell";

/**
 * WHERE A SETTING IS KEPT, SAID ON THE GROUP OR THE PANE — and derived from the
 * store each value is written to. Pinned against source because the mixed
 * panes are exactly where a wrong guess would hide.
 */
const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

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
  const nav = read("./settings-page.tsx");
  for (const [id, scope] of [
    ["appearance", "browser"],
    ["keybindings", "browser"],
    ["providers", "mac"],
    ["tools", "mac"],
    ["plugins", "mac"],
    ["projects", "project"],
    ["remote", "mac"],
    ["storage", "mac"],
    ["about", "mac"],
    ["updates", "mac"],
    ["source-control", "mac"],
  ]) {
    expect(nav).toMatch(new RegExp(`\\{ id: "${id}", [^}]*scope: "${scope}" \\}`));
  }
  // The mixed panes carry no pane scope; their groups do.
  for (const id of ["general", "integrations", "dictation"]) {
    expect(nav).not.toMatch(new RegExp(`\\{ id: "${id}", [^}]*scope:`));
  }
});

test("the mixed panes mark each group by where it is stored", () => {
  // Per browser: kept in this window's localStorage.
  expect(read("./links-section.tsx")).toContain('<SettingsGroup title="Links" scope="browser">');
  expect(read("./dictation-microphone-section.tsx")).toContain('<SettingsGroup title="Microphone" scope="browser">');
  // Per host: the inbox rule belongs to whichever engine the address bar names.
  expect(read("./inbox-section.tsx")).toContain('scope={hostFromPathname(pathname ?? "/") === LOCAL_HOST_ID ? "mac" : "host"}');
  // On the Mac: the engine's documents and the desktop shell's profiles.
  expect(read("./workspace-section.tsx")).toContain('<SettingsGroup title="New sessions" scope="mac">');
  expect(read("./textgen-section.tsx")).toContain('<SettingsGroup title="Generated text" scope="mac"');
  expect(read("./dictation-section.tsx")).toContain('<SettingsGroup title="Dictation" scope="mac">');
  expect(read("./browser-logins-section.tsx")).toContain('scope="mac"');
  expect(read("./browser-profiles-section.tsx").match(/scope="mac"/g)?.length).toBe(4);
});
