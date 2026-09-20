/**
 * THE MARKS A PROFILE WEARS (#366) — the two pickers, the settings row that
 * shows what they set, and the panel chip that is the whole reason for them.
 *
 * WHY THIS FILE HAS A DOM. A picker's grid does not exist until the popover
 * opens, so a static render can only ever see the trigger — and "the trigger
 * draws the current mark" is not the claim worth pinning. What the owner asked
 * for is "assign icons and colors", and the assignment is a click on a glyph
 * that has to arrive at the shell as an id. That is a press, and a press needs
 * the events a browser sends. The DOM is registered here and handed back in
 * `afterAll`, the way `right-panel.chooser.test.tsx` does it and for the same
 * reason: the suite shares a process with tests written for a world with no
 * `window`.
 *
 * The chip is pinned against the panel's SOURCE rather than mounted, matching
 * how `browser-live.test.ts` already treats that file — mounting it needs a
 * desktop bridge, a scope and a live WebContentsView, and the claim here is
 * about what the toolbar draws, which the markup states outright.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { IDENTITY_COLORS, TELAR_ICONS } from "@telar/engine-client";
import { IdentityIcon, identityColorVar, telarIconGlyph, NO_ICON_GLYPH } from "@/lib/telar-icons";
import { ProfileColorPicker, ProfileIconPicker } from "./browser-profile-marks";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const panel = readFileSync(new URL("../browser-live.tsx", import.meta.url), "utf8");
const section = readFileSync(new URL("./browser-profiles-section.tsx", import.meta.url), "utf8");

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

/** The events a browser sends on a press, on the deepest element under the
 *  pointer, held long enough for anything deferred to a frame to have had one. */
async function mouseClick(element: Element) {
  const target = element.querySelector("svg") ?? element;
  const init = { bubbles: true, cancelable: true, clientX: 0, clientY: 0, button: 0, detail: 1 };
  await act(async () => {
    target.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerType: "mouse" } as PointerEventInit));
    target.dispatchEvent(new MouseEvent("mousedown", init));
    await settle();
  });
  await act(async () => {
    target.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerType: "mouse" } as PointerEventInit));
    target.dispatchEvent(new MouseEvent("mouseup", init));
    target.dispatchEvent(new MouseEvent("click", init));
    await settle();
  });
}

function mount(element: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    trigger: host.querySelector("button")!,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe("the icon picker", () => {
  test("opens a grid of the app's own icons and hands back the id that was clicked", async () => {
    const picked: (string | null)[] = [];
    const { trigger, unmount } = mount(<ProfileIconPicker profile="Work" onPick={(icon) => picked.push(icon)} />);
    await mouseClick(trigger);

    const options = [...document.querySelectorAll('[role="radio"]')];
    // Forty icons, plus the "none" that makes clearing a click.
    expect(options).toHaveLength(TELAR_ICONS.length + 1);

    const briefcase = options.find((option) => option.getAttribute("aria-label") === "briefcase")!;
    expect(briefcase).toBeDefined();
    await mouseClick(briefcase);
    // The ID, not a component and not a rendered glyph: the store keeps a name
    // so an install that upgrades lucide keeps every icon a person chose.
    expect(picked).toEqual(["briefcase"]);
    unmount();
  });

  test("offers 'none' first-class, so a mark can be taken off", async () => {
    const picked: (string | null)[] = [];
    const { trigger, unmount } = mount(<ProfileIconPicker profile="Work" icon="globe" onPick={(icon) => picked.push(icon)} />);
    await mouseClick(trigger);
    const none = [...document.querySelectorAll('[role="radio"]')].find((option) => option.getAttribute("aria-label") === "No icon")!;
    await mouseClick(none);
    // null, not "" and not the absence of a call — the shell reads null as
    // "clear this" and an absent key as "leave it alone".
    expect(picked).toEqual([null]);
    unmount();
  });

  test("the current icon is checked, and the trigger says which profile it belongs to", async () => {
    const { trigger, unmount } = mount(<ProfileIconPicker profile="Client review" icon="rocket" onPick={() => {}} />);
    // A list of profiles is a list of these; without the name every one of them
    // is called "Icon" and a screen reader cannot tell them apart.
    expect(trigger.getAttribute("aria-label")).toBe("Icon for Client review");
    await mouseClick(trigger);
    const checked = [...document.querySelectorAll('[role="radio"][aria-checked="true"]')];
    expect(checked).toHaveLength(1);
    expect(checked[0]!.getAttribute("aria-label")).toBe("rocket");
    unmount();
  });
});

describe("the colour picker", () => {
  test("offers the eight identity hues and 'none', and hands back the token", async () => {
    const picked: (string | null)[] = [];
    const { trigger, unmount } = mount(<ProfileColorPicker profile="Work" onPick={(color) => picked.push(color)} />);
    expect(trigger.getAttribute("aria-label")).toBe("Colour for Work");
    await mouseClick(trigger);

    const options = [...document.querySelectorAll('[role="radio"]')];
    expect(options.map((option) => option.getAttribute("aria-label"))).toEqual([...IDENTITY_COLORS, "No colour"]);

    await mouseClick(options.find((option) => option.getAttribute("aria-label") === "amber")!);
    // A TOKEN, never a hex — the hue itself lives in `globals.css` and has a
    // different value in each theme.
    expect(picked).toEqual(["amber"]);
    unmount();
  });

  test("a hue is painted from its variable, so it follows the theme", async () => {
    const { trigger, unmount } = mount(<ProfileColorPicker profile="Work" color="sea" onPick={() => {}} />);
    await mouseClick(trigger);
    const sea = document.querySelector('[role="radio"][aria-label="sea"]') as HTMLElement;
    expect(sea.style.backgroundColor).toContain("--subject-sea");
    expect(sea.getAttribute("aria-checked")).toBe("true");
    unmount();
  });
});

describe("a mark, drawn", () => {
  test("a chosen icon is drawn in its colour", () => {
    const html = renderToStaticMarkup(<IdentityIcon icon="briefcase" color="amber" className="size-4" />);
    expect(html).toContain("lucide-briefcase");
    expect(html).toContain("var(--subject-amber)");
  });

  test("an unmarked profile gets the neutral ring and the surface's own colour, never a crash", () => {
    const html = renderToStaticMarkup(<IdentityIcon />);
    expect(html).toContain("lucide-circle");
    expect(html).toContain("currentColor");
    // A record from a build that knew an icon this one does not — a downgrade,
    // a half-applied update — still draws.
    expect(telarIconGlyph("a-glyph-from-the-future")).toBe(NO_ICON_GLYPH);
    expect(telarIconGlyph(undefined)).toBe(NO_ICON_GLYPH);
    expect(identityColorVar("chartreuse")).toBe("currentColor");
  });

  test("every id in the shared set has a glyph of its own", () => {
    // The list lives in engine-client and the glyphs are named imports here;
    // an id added there without a glyph would silently draw the fallback for
    // everyone who picked it.
    const glyphs = TELAR_ICONS.map((icon) => telarIconGlyph(icon));
    expect(glyphs.filter((glyph) => glyph === NO_ICON_GLYPH)).toHaveLength(0);
    expect(new Set(glyphs).size).toBe(TELAR_ICONS.length);
  });
});

describe("the browser panel's profile chip", () => {
  test("shows the profile's icon in its colour instead of its name", () => {
    expect(panel).toContain('<IdentityIcon icon={state.profile.icon} color={state.profile.color} className="size-3.5 shrink-0" />');
    // The name was the widest thing on the toolbar and the first to truncate;
    // this is the shape #366 took off it. MENUS may still write the name out —
    // the options menu's "Profile: <name>" row does (#473) — because a menu is
    // not the toolbar and has the room the toolbar does not.
    expect(panel).not.toContain('<span className="max-w-28 truncate">{state.profile.label}</span>');
  });

  test("the name is the tooltip and the accessible name — it is said, not dropped", () => {
    expect(panel).toContain("aria-label={`Browser profile: ${state.profile.label}");
    expect(panel).toContain("title={`Browser profile ${state.profile.label}");
  });

  test("the popover list keeps names, with the glyph beside each", () => {
    // The toolbar has one glyph's worth of room; the menu is where you choose,
    // and choosing between marks set weeks ago is choosing between names.
    expect(panel).toContain('<IdentityIcon icon={profile.icon} color={profile.color} className="size-3.5 shrink-0" />');
    expect(panel).toContain('<span className="min-w-0 flex-1 truncate">{profile.label}</span>');
  });
});

describe("the settings row", () => {
  test("wears the profile's own glyph rather than a generic person icon", () => {
    expect(section).toContain("icon={profileGlyph(profile)}");
    expect(section).toContain("<IdentityIcon icon={profile.icon} color={profile.color} className={className} />");
  });

  test("each mark is written on its own, so setting one cannot clear the other", () => {
    // The shell patches: an absent key leaves what is stored alone. A row that
    // sent both fields on every click would drop an icon whenever a colour was
    // picked — the exact bug the patch semantics exist to prevent.
    expect(section).toContain("bridge.updateProfile({ profileId: profile.id, icon })");
    expect(section).toContain("bridge.updateProfile({ profileId: profile.id, color })");
  });

  test("a profile named Default still does not also wear a Default badge", () => {
    // #357, re-pinned here because this row grew two controls around it.
    expect(section).toContain('profile.isDefault && profile.label.trim().toLowerCase() !== "default"');
  });
});
