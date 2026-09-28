/**
 * WHEN A CLAUDE SESSION COMPACTS ITSELF, from the card that offers it (#589).
 *
 * THE CLAIM WORTH TESTING IS THAT THERE IS ONE MECHANISM. The arithmetic is
 * pinned in `packages/engine-client/test/claude-compaction.test.ts`, against the
 * CLI's own formula; what is left for the card is the part a person meets —
 * that a variable typed into the list below arrives here as a state, that
 * choosing a state writes exactly those variables and nothing else, that
 * Default writes NO key rather than an empty one, and that a number the CLI
 * could not honour is refused with a sentence instead of quietly landing
 * somewhere else.
 *
 * AND THAT CODEX DOES NOT GET IT, because Codex reads none of these and a
 * control that does nothing is worse than an absent one.
 *
 * A DOM, because most of those claims are about what a reader sees after a
 * press. The registrar is handed back in `afterAll` the way the other render
 * suites in this folder do it. The one claim the DOM cannot carry — what a
 * TYPED number does — has its own group at the bottom, and says why there.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AutoCompact, ProviderInstance, ProviderInstanceEnvVar } from "@telar/engine-client";
import { compactionEdit, ProviderInstanceCard, type InheritanceNotice, type InstancePatch } from "./provider-instance-card";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function instanceWith(driver: ProviderInstance["driver"], env: ProviderInstanceEnvVar[] = [], autoCompact?: AutoCompact): ProviderInstance {
  return { id: driver, driver, enabled: true, env, createdAt: 1, updatedAt: 1, ...(autoCompact ? { autoCompact } : {}) };
}

async function mount(instance: ProviderInstance, inheritance?: InheritanceNotice) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const patches: InstancePatch[] = [];
  await act(async () => {
    root.render(
      <ProviderInstanceCard
        instance={instance}
        signInCommand="claude login"
        expanded
        onExpandedChange={() => undefined}
        onPatch={(patch) => patches.push(patch)}
        {...(inheritance ? { inheritance } : {})}
      />,
    );
    await settle();
  });
  return {
    host,
    patches,
    button: (label: string) =>
      [...host.querySelectorAll("button")].find((element) => element.textContent?.trim().startsWith(label)) as
        | HTMLButtonElement
        | undefined,
    radio: (label: string) =>
      [...host.querySelectorAll("[role=radio]")].find((button) => button.textContent?.trim() === label) as HTMLButtonElement | undefined,
    field: (label = "200k models") => host.querySelector(`[aria-label='Compact ${label} after how many tokens']`) as HTMLInputElement | null,
    info: () => host.querySelector("[aria-label='More about auto-compaction']")?.getAttribute("data-info") ?? "",
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

async function press(button: HTMLElement) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();
  });
}

describe("the compaction control", () => {
  const LIMITS: AutoCompact = { mode: "limits", standard: 120_000, long: 500_000 };

  test("every provider has it, each with what it cannot do behind the ⓘ", async () => {
    for (const driver of ["claude", "codex", "opencode"] as const) {
      const view = await mount(instanceWith(driver));
      expect(view.radio("Never compact")).toBeTruthy();
      expect(view.info()).not.toBe("");
      view.unmount();
    }
    const codex = await mount(instanceWith("codex"));
    expect(codex.info()).toContain("no switch that turns auto-compaction off");
    codex.unmount();
  });

  test("a login with no setting reads as Default", async () => {
    const view = await mount(instanceWith("claude"));
    expect(view.radio("Default")!.getAttribute("aria-checked")).toBe("true");
    expect(view.field()).toBeNull();
    expect(view.host.textContent).toContain("The provider decides");
    view.unmount();
  });

  test("the stored limits show one row per window class", async () => {
    const view = await mount(instanceWith("codex", [], LIMITS));
    expect(view.radio("Compact after…")!.getAttribute("aria-checked")).toBe("true");
    expect(view.field("200k models")!.value).toBe("120,000");
    expect(view.field("1M models")!.value).toBe("500,000");
    expect(view.host.textContent).toContain("the limit for its model's context window");
    view.unmount();
  });

  test("Compact after… starts at 150,000 and 400,000; Never and Default save their states", async () => {
    const view = await mount(instanceWith("claude"));
    await press(view.radio("Compact after…")!);
    expect(view.patches.at(-1)).toEqual({ autoCompact: { mode: "limits", standard: 150_000, long: 400_000 } });
    await press(view.radio("Never compact")!);
    expect(view.patches.at(-1)).toEqual({ autoCompact: { mode: "never" } });
    view.unmount();

    const configured = await mount(instanceWith("claude", [], LIMITS));
    await press(configured.radio("Default")!);
    expect(configured.patches.at(-1)).toEqual({ autoCompact: null });
    configured.unmount();
  });
});

/**
 * WHAT CONFIGURING A LOGIN COST IT, on the card that caused it (#594).
 *
 * The rule is the engine's and is pinned there — this is the half a person
 * meets. Two claims: that the notice names VARIABLES and never a value (three
 * of the names it can carry are credentials), and that it appears only when the
 * engine sent one, because on a Dock-launched Mac it never does.
 */
describe("the inheritance notice", () => {
  const notice = (over: Partial<InheritanceNotice> = {}): InheritanceNotice => ({
    names: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
    onCarryOver: () => undefined,
    onDismiss: () => undefined,
    ...over,
  });

  test("it names the variables, and shows no value for any of them", async () => {
    const view = await mount(instanceWith("claude", [{ name: "DISABLE_AUTO_COMPACT", value: "1", sensitive: false }]), notice());
    expect(view.host.textContent).toContain("stopped inheriting");
    expect(view.host.textContent).toContain("ANTHROPIC_BASE_URL");
    expect(view.host.textContent).toContain("ANTHROPIC_AUTH_TOKEN");
    // There is nowhere for a value to have come from — the notice is handed
    // names — and this is the assertion that keeps it that way if somebody
    // later decides it would be helpful to show one.
    expect(view.host.textContent).not.toContain("sk-ant");
    expect(view.host.textContent).not.toContain("127.0.0.1");
    view.unmount();
  });

  test("nothing is said when the engine said nothing", async () => {
    const view = await mount(instanceWith("claude", [{ name: "DISABLE_AUTO_COMPACT", value: "1", sensitive: false }]));
    // The ordinary case, and the only one on a Mac launched from the Dock.
    expect(view.host.textContent).not.toContain("stopped inheriting");
    view.unmount();
  });

  test("keeping them and dismissing are both offered", async () => {
    let kept = 0;
    let dismissed = 0;
    const view = await mount(
      instanceWith("claude", [{ name: "DISABLE_AUTO_COMPACT", value: "1", sensitive: false }]),
      notice({ onCarryOver: () => (kept += 1), onDismiss: () => (dismissed += 1) }),
    );
    await press(view.button("Keep them for this login")!);
    expect(kept).toBe(1);
    await press([...view.host.querySelectorAll("button")].find((element) => element.getAttribute("aria-label") === "Dismiss")!);
    expect(dismissed).toBe(1);
    view.unmount();
  });
});

/**
 * THE FIELD'S OWN DECISION, called directly.
 *
 * The note here used to say the input could not be driven at all — React's
 * change plugin never firing under happy-dom. That was #732, the cause was
 * import order in the test preload rather than the DOM, and it is fixed;
 * `test/type-into.ts` would reach this field today.
 *
 * It is still called directly, for the reason that survives: `compactionEdit`
 * is a pure arithmetic rule over what the CLI can honour, and the cases worth
 * pinning are the refusals at its edges. Typing each of them into a field would
 * be testing React's delegation once per case to learn the same answer. What is
 * NOT covered either way is the wiring from the field to this function — one
 * call site, and the kind of thing a driven test should now take.
 */
describe("what a typed limit does", () => {
  const current = { mode: "limits", standard: 150_000, long: 400_000 } as const;

  test("a whole number of tokens replaces that class's limit, separators and all", () => {
    expect(compactionEdit(current, "long", "600,000")).toEqual({ autoCompact: { mode: "limits", standard: 150_000, long: 600_000 } });
    expect(compactionEdit(current, "standard", "1000000")).toHaveProperty("autoCompact");
  });

  test("anything else is refused rather than clamped", () => {
    for (const typed of ["0", "1000001", "", "lots", "1.5"]) {
      expect(compactionEdit(current, "standard", typed)).toEqual({ refused: "A whole number of tokens from 1 to 1,000,000." });
    }
  });
});
