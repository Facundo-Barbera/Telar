/**
 * DELETING A BROWSER PROFILE, FROM THE ROW THAT OFFERS IT (#430).
 *
 * WHAT WENT WRONG WAS SILENCE. Delete did nothing on a machine that had been
 * used for a while: the shell refused every profile some session merely NAMED
 * (fixed in browser-manager's `whyProfileIsInUse`), and the pane's own
 * disabled reason lived in a `title` — a tooltip needs a mouse, a hover, and a
 * guess that there is anything to hover. So the two claims here are that the
 * reason is ON SCREEN, and that a refusal from the shell lands on the row it
 * was about rather than scrolling off the top of an eight-row list.
 *
 * AND WHAT THE ROW REFUSES IS NOW ONLY THE DEFAULT (#476). A profile projects
 * are assigned to is deletable, and they fall back to the default with it — so
 * the claim that moved here is the confirm's, which is the one place that
 * consequence is stated before it happens.
 *
 * A DOM, because both claims are about what a reader sees after a press. The
 * registrar is handed back in `afterAll` the way `browser-profile-marks.test.tsx`
 * does it — this suite shares a process with tests written for a world that has
 * no `window`.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { BrowserProfile } from "@/lib/desktop-browser-profiles";
import { BrowserProfilesSection } from "./browser-profiles-section";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/** Every Delete goes through a browser dialog, and happy-dom has no person to
 *  answer it. "Yes" is the default so each test says only what it is about; the
 *  test that is ABOUT the question replaces this to read it. */
beforeEach(() => {
  window.confirm = () => true;
});

afterEach(() => {
  delete (window as { telarDesktop?: unknown }).telarDesktop;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

/** Three rows, one of each kind a reader meets: the default, a profile a
 *  project is assigned to, and a spare nothing points at. */
const PROFILES: BrowserProfile[] = [
  { id: "bp_default", label: "Default", partition: "persist:a", createdAt: 1, isDefault: true, projects: [] },
  { id: "bp_work", label: "Work", partition: "persist:b", createdAt: 2, projects: ["project_aaaa"] },
  { id: "bp_spare", label: "Spare", partition: "persist:c", createdAt: 3, projects: [] },
];

function stubBridge(overrides: Record<string, unknown> = {}) {
  const bridge = {
    profiles: async () => ({ profiles: PROFILES }),
    createProfile: async () => ({ profiles: PROFILES, active: PROFILES[0] }),
    updateProfile: async () => ({ profiles: PROFILES }),
    setDefaultProfile: async () => ({ profiles: PROFILES }),
    deleteProfile: async () => ({ profiles: PROFILES.filter((profile) => profile.id !== "bp_spare") }),
    ...overrides,
  };
  (window as { telarDesktop?: unknown }).telarDesktop = { browser: bridge };
  return bridge;
}

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<BrowserProfilesSection />);
    await settle();
  });
  // The first read is a timeout inside an effect; its answer lands a turn later.
  await act(async () => {
    await settle();
  });
  return {
    host,
    /** The row a profile's name is written on. */
    row: (label: string) =>
      [...host.querySelectorAll("span")].find((span) => span.textContent === label)?.closest("div.flex.flex-wrap") as HTMLElement,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function deleteButton(row: HTMLElement) {
  return [...row.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Delete") as HTMLButtonElement;
}

async function press(button: HTMLElement) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();
  });
}

describe("browser profiles — deleting one", () => {
  test("the default is the only row that cannot be deleted, and it says why ON THE ROW", async () => {
    stubBridge();
    const view = await mount();

    // The sentence the tooltip used to keep to itself, in the row's own text —
    // including the half that says what to do about it.
    const fallback = view.row("Default");
    const refused = deleteButton(fallback);
    expect(refused.disabled).toBe(true);
    expect(fallback.textContent).toContain("Make another profile the default first.");
    expect(refused.getAttribute("aria-describedby")).toBe("profile-undeletable-bp_default");
    expect(fallback.querySelector("#profile-undeletable-bp_default")).toBeTruthy();

    // A profile a project is assigned to is deletable now (#476): its projects
    // fall back to the default, so the row has nothing left to warn about.
    const assigned = view.row("Work");
    expect(deleteButton(assigned).disabled).toBe(false);
    expect(deleteButton(assigned).getAttribute("aria-describedby")).toBeNull();
    expect(assigned.textContent).not.toContain("another profile first");

    // A profile nothing points at offers a live button and says nothing extra.
    const spare = view.row("Spare");
    expect(deleteButton(spare).disabled).toBe(false);
    expect(deleteButton(spare).getAttribute("aria-describedby")).toBeNull();
    expect(spare.textContent).not.toContain("cannot be deleted");
    view.unmount();
  });

  test("the confirm names how many projects move and where they move to", async () => {
    stubBridge();
    const view = await mount();
    const asked: string[] = [];
    window.confirm = (message?: string) => {
      asked.push(String(message));
      return false;
    };

    // Refused at the dialog: nothing is asked of the shell, and the row stays.
    await press(deleteButton(view.row("Work")));
    expect(asked).toEqual(['Delete "Work"? 1 project will use "Default" instead. Sessions browsing in it move over, and its open tabs reload signed out. Its cookies stay on disk.']);
    expect(view.row("Work")).toBeTruthy();

    // A profile nothing is assigned to has no move to report, only the jar.
    await press(deleteButton(view.row("Spare")));
    expect(asked[1]).toBe('Delete "Spare"? Sessions browsing in it move over, and its open tabs reload signed out. Its cookies stay on disk.');
    view.unmount();
  });

  test("a profile nothing points at is deleted, and the shell's own list is what replaces the row", async () => {
    stubBridge();
    const view = await mount();
    await press(deleteButton(view.row("Spare")));
    expect(view.row("Spare")).toBeFalsy();
    expect(view.row("Work")).toBeTruthy();
    view.unmount();
  });

  test("a refusal from the shell reads on the row it was about, not as a silent no-op", async () => {
    /**
     * The shell knows what this pane cannot: which sessions have tabs open in
     * a profile. So a Delete that looked perfectly available comes back
     * refused, and that sentence is the only explanation a reader gets.
     */
    const refusal = "A session has a tab open in “Spare”. Close it, or switch that session to another profile, first.";
    stubBridge({
      deleteProfile: async () => {
        throw new Error(refusal);
      },
    });
    const view = await mount();
    await press(deleteButton(view.row("Spare")));

    const spare = view.row("Spare");
    // Still there — and saying so.
    expect(spare).toBeTruthy();
    expect(spare.textContent).toContain(refusal);
    const alert = spare.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(refusal);
    // On ITS row, not on somebody else's.
    expect(view.row("Work").querySelector('[role="alert"]')).toBeFalsy();
    view.unmount();
  });
});
