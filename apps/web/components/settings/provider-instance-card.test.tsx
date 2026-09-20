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
import type { ProviderInstance, ProviderInstanceEnvVar } from "@telar/engine-client";
import { compactionEdit, ProviderInstanceCard, type InheritanceNotice, type InstancePatch } from "./provider-instance-card";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function instanceWith(driver: ProviderInstance["driver"], env: ProviderInstanceEnvVar[] = []): ProviderInstance {
  return { id: driver, driver, enabled: true, env, createdAt: 1, updatedAt: 1 };
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
    field: () => host.querySelector("[aria-label='Compact after how many tokens']") as HTMLInputElement | null,
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
  test("a Claude login has it and a Codex login does not", async () => {
    const claude = await mount(instanceWith("claude"));
    expect(claude.radio("Never compact")).toBeTruthy();
    expect(claude.host.textContent).toContain("Auto-compaction");
    claude.unmount();

    const codex = await mount(instanceWith("codex"));
    expect(codex.radio("Never compact")).toBeUndefined();
    expect(codex.host.textContent).not.toContain("Auto-compaction");
    // The variables list is still there — this removes a control, not a card.
    expect(codex.host.textContent).toContain("Environment variables");
    codex.unmount();
  });

  test("a login nobody has configured reads as Default", async () => {
    const view = await mount(instanceWith("claude"));
    expect(view.radio("Default")!.getAttribute("aria-checked")).toBe("true");
    expect(view.field()).toBeNull();
    view.unmount();
  });

  test("a variable typed by hand is what the control reads back", async () => {
    // Nothing here was written by the control. 200 000 declared, minus the
    // CLI's own 20 000 output reserve and 13 000 summary buffer.
    const view = await mount(instanceWith("claude", [{ name: "CLAUDE_CODE_AUTO_COMPACT_WINDOW", value: "200000", sensitive: false }]));
    expect(view.radio("Compact after…")!.getAttribute("aria-checked")).toBe("true");
    expect(view.field()!.value).toBe("167,000");
    view.unmount();
  });

  test("a percentage with no window says so rather than showing a number", async () => {
    const view = await mount(instanceWith("claude", [{ name: "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", value: "40", sensitive: false }]));
    expect(view.field()).toBeNull();
    expect(view.host.textContent).toContain("no token count to show");
    // No state is claimed for a login whose environment does not name one.
    for (const label of ["Default", "Compact after…", "Never compact"]) {
      expect(view.radio(label)!.getAttribute("aria-checked")).toBe("false");
    }
    view.unmount();
  });

  test("Never compact writes the one variable, and Default writes none at all", async () => {
    const view = await mount(instanceWith("claude", [{ name: "ANTHROPIC_BASE_URL", value: "https://example.test", sensitive: false }]));
    await press(view.radio("Never compact")!);
    expect(view.patches.at(-1)!.env).toEqual([
      { name: "ANTHROPIC_BASE_URL", value: "https://example.test", sensitive: false },
      { name: "DISABLE_AUTO_COMPACT", value: "1", sensitive: false },
    ]);
    view.unmount();

    const configured = await mount(
      instanceWith("claude", [
        { name: "CLAUDE_CODE_AUTO_COMPACT_WINDOW", value: "183000", sensitive: false },
        { name: "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", value: "92.02454", sensitive: false },
      ]),
    );
    await press(configured.radio("Default")!);
    // THE KEYS GO, rather than being set to "". An empty string is a value the
    // CLI reads.
    expect(configured.patches.at(-1)!.env).toEqual([]);
    configured.unmount();
  });

  test("the field shows the stored number with separators", async () => {
    const view = await mount(instanceWith("claude", [{ name: "CLAUDE_CODE_AUTO_COMPACT_WINDOW", value: "183000", sensitive: false }]));
    expect(view.field()!.value).toBe("150,000");
    view.unmount();
  });

  test("the small print states the clamp, and claims no percentage of a model window", async () => {
    const view = await mount(instanceWith("claude", [{ name: "CLAUDE_CODE_AUTO_COMPACT_WINDOW", value: "183000", sensitive: false }]));
    // 150 000 + the CLI's 33 000 of reserved headroom.
    expect(view.host.textContent).toContain("any model with at least 183,000 tokens of context");
    expect(view.host.textContent).toContain("compacts earlier — never later");
    // The conversion consults no model, so the card must not imply one.
    expect(view.host.textContent).not.toContain("% of this model");
    view.unmount();
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
 * `lib/testing/type-into.ts` would reach this field today.
 *
 * It is still called directly, for the reason that survives: `compactionEdit`
 * is a pure arithmetic rule over what the CLI can honour, and the cases worth
 * pinning are the refusals at its edges. Typing each of them into a field would
 * be testing React's delegation once per case to learn the same answer. What is
 * NOT covered either way is the wiring from the field to this function — one
 * call site, and the kind of thing a driven test should now take.
 */
describe("what a typed threshold does", () => {
  const configured: ProviderInstanceEnvVar[] = [{ name: "CLAUDE_CODE_AUTO_COMPACT_WINDOW", value: "183000", sensitive: false }];

  test("a number it can honour becomes the pair, separators and all", () => {
    expect(compactionEdit(configured, "120,000")).toEqual({
      env: [
        { name: "CLAUDE_CODE_AUTO_COMPACT_WINDOW", value: "153000", sensitive: false },
        { name: "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", value: "90.225564", sensitive: false },
      ],
    });
  });

  test("a number past what the CLI can honour is refused rather than clamped", () => {
    // 967 000 is the last one the CLI's own 1 000 000 window can hold with its
    // reserves. Past it the CLI would cap the window and compact EARLIER than
    // the number on screen, which is the one thing this control must not do.
    expect(compactionEdit(configured, "967000")).toHaveProperty("env");
    for (const typed of ["967001", "2000000", "0", "", "lots"]) {
      const edit = compactionEdit(configured, typed);
      expect(edit).not.toHaveProperty("env");
      expect((edit as { refused: string }).refused).toContain("Between 1 and 967,000 tokens");
    }
  });
});
