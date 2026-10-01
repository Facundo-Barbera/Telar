import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { SlidersHorizontalIcon } from "lucide-react";
import { Row, SettingsGroup, SettingsShell, ToggleRow, useRestoreDefaults } from "./settings-shell";

GlobalRegistrator.register({ url: "http://localhost/settings" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => GlobalRegistrator.unregister());


const PANES = [
  { id: "general", label: "General", icon: SlidersHorizontalIcon },
  { id: "projects", label: "Projects", icon: SlidersHorizontalIcon },
];

function shell(active = "general") {
  return renderToStaticMarkup(
    <SettingsShell title="Settings" sections={PANES} active={active} onSelect={() => undefined}>
      <SettingsGroup title="Settling">
        <Row label="Settle quiet sessions" />
      </SettingsGroup>
    </SettingsShell>,
  );
}

test("an unavailable control is inert, and the reason stands in for the hint", () => {
  const html = renderToStaticMarkup(
    <Row
      label="LaTeX"
      hint="Compile documents from this project's checkout."
      unavailable={{ reason: "This plugin did not start." }}
      control={<button type="button">Configure</button>}
    />,
  );
  expect(html).toContain("inert=");
  expect(html).toContain("This plugin did not start.");
  expect(html).not.toContain("Compile documents");
  expect(html).toContain("Configure");
});

test("an available row leaves its control alone", () => {
  const html = renderToStaticMarkup(<Row label="LaTeX" hint="Compile documents." control={<button type="button">Configure</button>} />);
  expect(html).not.toContain("inert=");
  expect(html).toContain("Compile documents.");
});

test("status reads beside the label, not inside the control", () => {
  const html = renderToStaticMarkup(<Row label="Engine" status={<span>Not answering</span>} control={<button type="button">Restart</button>} />);
  // Before the control in document order — a row's state is read with its name.
  expect(html.indexOf("Not answering")).toBeGreaterThan(-1);
  expect(html.indexOf("Not answering")).toBeLessThan(html.indexOf("Restart"));
});

test("the revert slot is reserved whether or not the arrow is in it", () => {
  const at = (html: string) => html.indexOf('<span class="flex size-3 shrink-0 items-center justify-center">');
  const plain = renderToStaticMarkup(<Row label="Model" control={<span>gpt</span>} />);
  const reverting = renderToStaticMarkup(<Row label="Model" onRevert={() => undefined} control={<span>gpt</span>} />);
  expect(at(plain)).toBeGreaterThan(-1);
  expect(at(reverting)).toBe(at(plain));
  expect(plain).not.toContain("Revert to the default");
  expect(reverting).toContain("Revert to the default");
});

test("a refused write reads under the hint, and does not take its place", () => {
  const html = renderToStaticMarkup(
    <Row
      label="Workspace"
      hint="Sessions share the project's checkout. Two at once will collide."
      error="The engine refused that default."
      control={<span>Project checkout</span>}
    />,
  );
  expect(html).toContain("Two at once will collide.");
  expect(html).toContain("The engine refused that default.");
  expect(html.indexOf("Two at once will collide.")).toBeLessThan(html.indexOf("The engine refused that default."));
  expect(html).toContain("text-destructive");
  expect(html).toContain('role="alert"');
});

test("a row with no error renders no alert at all", () => {
  const html = renderToStaticMarkup(<Row label="Workspace" hint="Sessions share the project's checkout." />);
  expect(html).not.toContain('role="alert"');
  expect(html).not.toContain("text-destructive");
});

test("an errored row keeps showing the value the engine still holds", () => {
  const html = renderToStaticMarkup(
    <Row label="Settle quiet sessions" error="The engine refused that window." control={<span data-value="72">72 hours</span>} />,
  );
  expect(html).toContain("72 hours");
  expect(html).toContain("The engine refused that window.");
});

test("a toggle row carries the revert arrow and the error through too", () => {
  const html = renderToStaticMarkup(
    <ToggleRow
      label="Name sessions"
      hint="Replaces the truncated first message."
      checked={false}
      onCheckedChange={() => undefined}
      onRevert={() => undefined}
      error="The engine refused the change."
    />,
  );
  expect(html).toContain("Revert to the default");
  expect(html).toContain("The engine refused the change.");
  expect(html).toContain("Replaces the truncated first message.");
});

test("a toggle row carries status and unavailable through to the Row", () => {
  const html = renderToStaticMarkup(
    <ToggleRow
      label="Name sessions"
      status={<span>Beta</span>}
      checked={false}
      onCheckedChange={() => undefined}
      unavailable={{ reason: "No provider is configured to name them." }}
    />,
  );
  expect(html).toContain("Beta");
  expect(html).toContain("inert=");
  expect(html).toContain("No provider is configured to name them.");
});

test("the header is a breadcrumb saying where this pane sits", () => {
  const html = shell("projects");
  expect(html).toContain('aria-label="Breadcrumb"');
  expect(html.indexOf(">Settings<")).toBeLessThan(html.indexOf(">Projects<"));
  expect(html).toContain('aria-current="page"');
});

test("the crumb's first segment is whatever the shell is called, not the word Settings", () => {
  const html = renderToStaticMarkup(
    <SettingsShell title="Telar" sections={PANES} active="general" onSelect={() => undefined}>
      <SettingsGroup title="Identity">
        <Row label="Name" />
      </SettingsGroup>
    </SettingsShell>,
  );
  expect(html).toContain(">Telar<");
});

test("with nothing registered there is no Restore defaults, and no save bar", () => {
  const html = shell();
  expect(html).not.toContain("Restore defaults");
  expect(html).not.toContain("Save changes");
  expect(html).not.toContain("Unsaved");
});

test("Restore defaults appears while a mounted section offers defaults, and runs them all", async () => {
  const calls: string[] = [];
  function Section({ name }: { name: string }) {
    useRestoreDefaults(() => void calls.push(name));
    return null;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = (children: ReactNode) =>
    act(async () =>
      root.render(
        <SettingsShell title="Settings" sections={PANES} active="general" onSelect={() => undefined}>
          {children}
        </SettingsShell>,
      ),
    );
  const button = () => [...host.querySelectorAll("button")].find((node) => node.textContent?.includes("Restore defaults"));

  await render(
    <>
      <Section name="a" />
      <Section name="b" />
    </>,
  );
  await act(async () => button()?.click());
  expect(calls).toEqual(["a", "b"]);

  await render(<p>facts</p>);
  expect(button()).toBeUndefined();
  await act(async () => root.unmount());
  host.remove();
});
test("a group draws one card, with its rows hairlined inside it", () => {
  const html = renderToStaticMarkup(
    <SettingsGroup title="Organization">
      <Row label="Project grouping" hint="Combine matching repositories across environments." />
      <Row label="Auto-settle merged threads" hint="Settle a thread when its pull request merges." />
    </SettingsGroup>,
  );
  const card = 'class="divide-y divide-border/60 rounded-xl border border-border bg-card shadow-1 [&amp;&gt;*]:px-4"';
  expect(html).toContain(card);
  expect(html.split(card).length - 1).toBe(1);
  expect(html).toContain("Project grouping");
  expect(html).toContain("Auto-settle merged threads");
});

test("the group's title is a caption ABOVE the card, and leads the rows without outgrowing them", () => {
  const html = renderToStaticMarkup(
    <SettingsGroup title="Organization">
      <Row label="Project grouping" />
    </SettingsGroup>,
  );
  expect(html.indexOf("Organization")).toBeLessThan(html.indexOf("rounded-xl border border-border bg-card"));
  expect(html).toContain('<h4 class="font-heading text-xs-plus font-semibold tracking-tight text-foreground">');
  expect(html).not.toContain("text-foreground/70");
  expect(html).not.toContain("text-base font-semibold");
});

test("a group with no title is still a card, so a captionless group is not a loose list", () => {
  const html = renderToStaticMarkup(
    <SettingsGroup>
      <Row label="Browser profiles" />
    </SettingsGroup>,
  );
  expect(html).toContain("rounded-xl border border-border bg-card");
  expect(html).not.toContain("<h4");
});

test("a row inside a group carries the derived anchor and takes focus", () => {
  const html = renderToStaticMarkup(
    <SettingsGroup title="Settling">
      <Row label="Settle quiet sessions" hint="Off means nothing leaves the list on its own." />
    </SettingsGroup>,
  );
  expect(html).toContain('id="settings-row-settling-settle-quiet-sessions"');
  expect(html).toContain('tabindex="-1"');
});

test("the group's title only names rows when it is a plain string", () => {
  const html = renderToStaticMarkup(
    <SettingsGroup title={<span>Acme&apos;s servers</span>}>
      <Row label="Add a server" />
    </SettingsGroup>,
  );
  expect(html).toContain('id="settings-row-add-a-server"');
});

test("an explicit id wins, for labels that are not text", () => {
  const html = renderToStaticMarkup(<Row id="settings-row-paired-device" label={<strong>iPhone</strong>} />);
  expect(html).toContain('id="settings-row-paired-device"');
});

test("a toggle row is a destination too", () => {
  const html = renderToStaticMarkup(
    <SettingsGroup title="Generated text">
      <ToggleRow label="Name sessions" checked={false} onCheckedChange={() => undefined} />
    </SettingsGroup>,
  );
  expect(html).toContain('id="settings-row-generated-text-name-sessions"');
});

const resizeHandle = () => {
  const html = shell();
  const at = html.indexOf('aria-label="Resize settings sidebar"');
  expect(at).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<button", at);
  return html.slice(start, html.indexOf("</button>", at) + "</button>".length);
};

test("the settings resize handle renders no child element", () => {
  expect(resizeHandle()).toMatch(/<button\b[^>]*><\/button>/);
});

test("and draws nothing of its own — no hairline, no after:bg-*", () => {
  const html = resizeHandle();
  expect(html).not.toContain("w-px");
  expect(html).not.toContain("bg-sidebar-border");
  expect(html).not.toContain("after:bg-");
});

test("but it is still a handle, and still reachable by keyboard", () => {
  const html = resizeHandle();
  expect(html).toContain("w-[var(--app-island-inset)]");
  expect(html).toContain("cursor-col-resize");
  expect(html).toContain("focus-visible:ring-ring");
});
