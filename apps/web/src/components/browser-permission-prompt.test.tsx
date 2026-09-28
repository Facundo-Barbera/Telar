/**
 * THE PROMPT SAYS WHAT IS BEING ASKED, AND OFFERS THE THREE ANSWERS.
 *
 * The sentences are tested as functions and the markup as markup, the split this
 * app uses everywhere: what a prompt SAYS is the part a person acts on and it is
 * pure, while the part that can silently rot is a button that stopped being
 * rendered. Both matter here for the same reason — a permission prompt that
 * misnames what it is about is worse than no prompt at all.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  describePermissionKinds,
  describeSitePermission,
  describeSiteStanding,
  isPermissionKind,
  permissionPromptTitle,
  siteLabel,
  PERMISSION_KINDS,
  type PermissionPrompt,
  type SitePermissionKind,
} from "@/lib/desktop-site-permissions";
import { describePermissionDenial, SitePermissionPrompt, SitePermissionsPopover } from "./browser-permission-prompt";

const prompt = (patch: Partial<PermissionPrompt> = {}): PermissionPrompt => ({
  requestId: "perm_1",
  scopeKey: "session_1",
  tabId: "tab_1",
  partition: "persist:telar-profile-bp_1",
  origin: "https://meet.example.com",
  kinds: ["camera", "microphone"],
  askedAt: 1,
  ...patch,
});

describe("the words every surface prints", () => {
  test("the kinds are the page's vocabulary, not Chromium's", () => {
    expect(describePermissionKinds(["camera"])).toBe("camera");
    expect(describePermissionKinds(["camera", "microphone"])).toBe("camera and microphone");
    // "location", not "geolocation" — it is what a person is being asked about.
    expect(describePermissionKinds(["geolocation"])).toBe("location");
    expect(describePermissionKinds(["clipboard-read"])).toBe("clipboard");
    expect(describePermissionKinds(["camera", "microphone", "geolocation"])).toBe("camera, microphone and location");
  });

  test("a site is its host, except when the scheme is the thing worth noticing", () => {
    expect(siteLabel("https://meet.example.com")).toBe("meet.example.com");
    // An insecure page keeps its scheme rather than passing for a secure one.
    expect(siteLabel("http://localhost:3000")).toBe("http://localhost:3000");
    expect(siteLabel("not an origin")).toBe("not an origin");
  });

  test("the title names the site and what it asked for; screen share asks a different question", () => {
    expect(permissionPromptTitle(prompt())).toBe("meet.example.com wants to use your camera and microphone");
    // Not "may I" but "which one" — so it does not pretend to be the same ask.
    expect(permissionPromptTitle(prompt({ kinds: ["display-capture"] }))).toBe("meet.example.com wants to share your screen");
  });

  test("a remembered row is said in the words of the decision that made it", () => {
    expect(describeSitePermission({ kind: "camera", decision: "allow", at: 1 })).toBe("Camera — allowed");
    expect(describeSitePermission({ kind: "display-capture", decision: "block", at: 1 })).toBe("Screen sharing — blocked");
  });

  test("the lock's sentence distinguishes the three states a reader acts on differently", () => {
    const site = "https://meet.example.com";
    expect(describeSiteStanding(site, [])).toBe("meet.example.com has not asked for anything.");
    expect(describeSiteStanding(site, [{ kind: "camera", decision: "allow", at: 1 }])).toBe("meet.example.com can use your camera.");
    expect(
      describeSiteStanding(site, [
        { kind: "camera", decision: "allow", at: 1 },
        { kind: "microphone", decision: "allow", at: 1 },
        { kind: "geolocation", decision: "block", at: 1 },
      ]),
    ).toBe("meet.example.com can use your camera and microphone, and is blocked from your location.");
  });

  test("the OS refusal is a sentence the page could never have given", () => {
    expect(
      describePermissionDenial({
        origin: "https://meet.example.com",
        kinds: ["camera"],
        reason: "macOS is blocking Telar's camera. Turn Telar on in System Settings ▸ Privacy & Security ▸ Camera, then reload the page.",
      }),
    ).toBe(
      "meet.example.com could not use your camera. macOS is blocking Telar's camera. Turn Telar on in System Settings ▸ Privacy & Security ▸ Camera, then reload the page.",
    );
  });

  test("the vocabulary is closed, and it is the shell's", () => {
    expect([...PERMISSION_KINDS]).toEqual(["camera", "microphone", "notifications", "geolocation", "clipboard-read", "display-capture"]);
    expect(isPermissionKind("camera")).toBe(true);
    expect(isPermissionKind("midi")).toBe(false);
  });
});

describe("the prompt", () => {
  const render = (node: React.ReactElement) => renderToStaticMarkup(node);

  test("asks the question and offers exactly the three answers", () => {
    const html = render(<SitePermissionPrompt prompt={prompt()} onAnswer={() => {}} />);
    expect(html).toContain("meet.example.com wants to use your camera and microphone");
    for (const label of ["Allow", "Allow once", "Block"]) expect(html).toContain(`>${label}</button>`);
    // The middle answer's whole meaning, said rather than left to be guessed.
    expect(html).toContain("“Allow once” is not");
  });

  test("says where the answer is remembered — the same site in another profile asks again", () => {
    expect(render(<SitePermissionPrompt prompt={prompt()} onAnswer={() => {}} />)).toContain("Remembered for this browser profile");
  });

  test("a decision in flight locks the buttons rather than leaving them live", () => {
    const html = render(<SitePermissionPrompt prompt={prompt()} onAnswer={() => {}} busy />);
    // `\s` matters: the button primitive also writes `data-disabled`, and a
    // bare match would count each button twice and pass with two of three.
    expect(html.match(/\sdisabled=""/g) ?? []).toHaveLength(3);
  });

  test("every kind reaches the prompt with a glyph of its own", () => {
    for (const kind of PERMISSION_KINDS as readonly SitePermissionKind[]) {
      if (kind === "display-capture") continue; // its prompt is the picker below
      const html = render(<SitePermissionPrompt prompt={prompt({ kinds: [kind] })} onAnswer={() => {}} />);
      expect(html).toContain("<svg");
      expect(html).toContain(permissionPromptTitle(prompt({ kinds: [kind] })));
    }
  });
});

describe("the screen-share picker, which IS the prompt", () => {
  const sharing = prompt({
    kinds: ["display-capture"],
    sources: [
      { id: "window:42:0", name: "Telar", kind: "window", thumbnail: "data:image/png;base64,w" },
      { id: "screen:0:0", name: "Entire screen", kind: "screen", thumbnail: "data:image/png;base64,s" },
      { id: "window:43:0", name: "No preview", kind: "window", thumbnail: null },
    ],
  });

  test("lists what can be shared, screens first", () => {
    const html = renderToStaticMarkup(<SitePermissionPrompt prompt={sharing} onAnswer={() => {}} />);
    // Sharing a whole display is the coarse, common answer; the window hunt is
    // the case that needs the list.
    expect(html.indexOf("Entire screen")).toBeLessThan(html.indexOf("Telar"));
    expect(html).toContain('src="data:image/png;base64,s"');
    // A source this Mac gave no preview for still gets a row, not a gap.
    expect(html).toContain("No preview");
  });

  test("Share is locked until something is chosen, and Cancel is not Block", () => {
    const html = renderToStaticMarkup(<SitePermissionPrompt prompt={sharing} onAnswer={() => {}} />);
    expect(html).toMatch(/disabled=""[^>]*>Share</);
    // Changing your mind about which window is not a decision about the site.
    expect(html).toContain(">Cancel</button>");
    expect(html).toContain(">Never allow</button>");
    expect(html).not.toContain(">Allow once</button>");
  });
});

describe("the lock popover", () => {
  const records = [
    { kind: "camera" as const, decision: "allow" as const, at: 1 },
    { kind: "geolocation" as const, decision: "block" as const, at: 2 },
  ];

  test("lists what the site holds, and offers both a per-kind and a whole-site take-back", () => {
    const html = renderToStaticMarkup(
      <SitePermissionsPopover origin="https://meet.example.com" records={records} onForget={() => {}} onReset={() => {}} />,
    );
    expect(html).toContain("Camera — allowed");
    expect(html).toContain("Location — blocked");
    expect(html.match(/>Forget</g) ?? []).toHaveLength(2);
    expect(html).toContain("Reset permissions");
    expect(html).toContain("meet.example.com can use your camera, and is blocked from your location.");
  });

  test("a site that has asked for nothing offers nothing to revoke", () => {
    const html = renderToStaticMarkup(
      <SitePermissionsPopover origin="https://quiet.example" records={[]} onForget={() => {}} onReset={() => {}} />,
    );
    expect(html).toContain("quiet.example has not asked for anything.");
    expect(html).not.toContain("Reset permissions");
  });

  test("a blank tab says why there is nothing here rather than showing an empty list", () => {
    const html = renderToStaticMarkup(<SitePermissionsPopover origin={undefined} records={[]} onForget={() => {}} onReset={() => {}} />);
    expect(html).toContain("No site open");
    expect(html).toContain("a blank tab has none");
  });
});
