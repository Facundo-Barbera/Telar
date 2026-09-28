/**
 * The editor's one genuinely tricky rule: a secret the cockpit was never sent
 * must survive being edited around, and must never be silently erased.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { RunConfigurationView } from "@/lib/run/types";
import {
  configurationPatch,
  draftFromConfiguration,
  editorProblems,
  emptyDraft,
  environmentBlocker,
  environmentTouched,
  toDraft,
  visibleProblems,
} from "./run-config-editor";

const config = (overrides: Partial<RunConfigurationView> = {}): RunConfigurationView => ({
  id: "cfg_1",
  projectId: "proj_1",
  name: "web dev",
  command: "bun run dev",
  createdAt: 1,
  updatedAt: 1,
  env: [],
  ...overrides,
});

describe("draftFromConfiguration", () => {
  test("a secret opens as kept, with no value to accidentally save", () => {
    // `RunEnvView` has no `value` for a secret — the cockpit is never sent one.
    // An empty box here would look like "the value is blank".
    const draft = draftFromConfiguration(config({ env: [{ key: "TOKEN", secret: true }, { key: "MODE", value: "dev" }] }));
    expect(draft.env[0]).toEqual({ key: "TOKEN", value: "", secret: true, kept: true });
    expect(draft.env[1]).toEqual({ key: "MODE", value: "dev" });
  });
});

describe("environmentTouched", () => {
  test("opening and closing the form changes nothing", () => {
    const original = config({ env: [{ key: "TOKEN", secret: true }, { key: "MODE", value: "dev" }] });
    expect(environmentTouched(original, draftFromConfiguration(original))).toBe(false);
  });

  test("editing a plain value, adding a row, or removing one all count", () => {
    const original = config({ env: [{ key: "MODE", value: "dev" }] });
    const draft = draftFromConfiguration(original);
    expect(environmentTouched(original, { ...draft, env: [{ key: "MODE", value: "prod" }] })).toBe(true);
    expect(environmentTouched(original, { ...draft, env: [] })).toBe(true);
    expect(environmentTouched(original, { ...draft, env: [...draft.env, { key: "PORT", value: "3000" }] })).toBe(true);
  });

  test("replacing a secret counts, because the new value has to be sent", () => {
    const original = config({ env: [{ key: "TOKEN", secret: true }] });
    const draft = draftFromConfiguration(original);
    expect(environmentTouched(original, { ...draft, env: [{ key: "TOKEN", value: "s3cret", secret: true }] })).toBe(true);
  });
});

describe("configurationPatch", () => {
  test("an untouched environment is left OUT of the patch, so the stored secret survives", () => {
    // The engine merges the patch shallowly. Sending `env` here would send the
    // secret as an empty string and erase it.
    const original = config({ env: [{ key: "TOKEN", secret: true }] });
    const draft = { ...draftFromConfiguration(original), command: "bun run start" };
    const patch = configurationPatch(original, draft);
    expect(patch.env).toBeUndefined();
    expect(patch.command).toBe("bun run start");
  });

  test("a touched environment is sent whole", () => {
    const original = config({ env: [{ key: "MODE", value: "dev" }] });
    const draft = { ...draftFromConfiguration(original), env: [{ key: "MODE", value: "prod" }] };
    expect(configurationPatch(original, draft).env).toEqual([{ key: "MODE", value: "prod" }]);
  });

  test("blank optionals are dropped rather than saved as empty strings", () => {
    expect(toDraft({ ...emptyDraft(), name: " web ", command: " bun run dev " })).toEqual({
      name: "web",
      icon: "play",
      command: "bun run dev",
    });
  });

  test("a pinned shell is left OUT of the patch, so editing the command does not unpin it", () => {
    // This form has no shell field — a recipe gets one from an agent or the
    // API. The engine merges shallowly, so the patch must not mention `shell`
    // at all; mentioning it as `undefined` would be the same erasure the
    // environment rule above exists to prevent.
    const original = config({ shell: { program: "/bin/bash", args: ["-lc"] } });
    const patch = configurationPatch(original, { ...draftFromConfiguration(original), command: "bun run start" });
    expect("shell" in patch).toBe(false);
    expect(patch.command).toBe("bun run start");
  });
});

describe("the icon", () => {
  test("a configuration without one opens the picker on the default", () => {
    // Absent is not blank: every configuration saved before icons existed
    // lands here, and the form must not present that as "no choice made".
    expect(draftFromConfiguration(config()).icon).toBe("play");
    expect(draftFromConfiguration(config({ icon: "database" })).icon).toBe("database");
    expect(emptyDraft().icon).toBe("play");
  });

  test("the icon is ALWAYS in the patch, including the default", () => {
    // The engine merges shallowly, so an omitted `icon` means "leave it
    // alone". Dropping the default here would make switching a configuration
    // back to `play` silently impossible — the stored `server` would survive a
    // save the human watched succeed.
    const original = config({ icon: "server" });
    const reverted = { ...draftFromConfiguration(original), icon: "play" as const };
    expect(configurationPatch(original, reverted).icon).toBe("play");
    expect(configurationPatch(original, draftFromConfiguration(original)).icon).toBe("server");
  });
});

describe("environmentBlocker", () => {
  test("changing the environment while a secret is still hidden is refused, by name", () => {
    // The alternative is erasing a token the human never saw and cannot retype
    // from memory of this form.
    const original = config({ env: [{ key: "TOKEN", secret: true }] });
    const draft = draftFromConfiguration(original);
    const blocked = { ...draft, env: [...draft.env, { key: "PORT", value: "3000" }] };
    expect(environmentBlocker(original, blocked)).toContain("TOKEN");
    expect(editorProblems(original, blocked).some((problem) => problem.field === "env")).toBe(true);
  });

  test("re-entering the secret clears the block", () => {
    const original = config({ env: [{ key: "TOKEN", secret: true }] });
    const fixed = {
      ...draftFromConfiguration(original),
      env: [{ key: "TOKEN", value: "s3cret", secret: true }, { key: "PORT", value: "3000" }],
    };
    expect(environmentBlocker(original, fixed)).toBeUndefined();
    expect(editorProblems(original, fixed)).toEqual([]);
  });

  test("nothing is in the way when the environment was not touched at all", () => {
    const original = config({ env: [{ key: "TOKEN", secret: true }] });
    expect(environmentBlocker(original, draftFromConfiguration(original))).toBeUndefined();
    expect(editorProblems(original, draftFromConfiguration(original))).toEqual([]);
  });

  test("a new configuration validates its secrets normally", () => {
    const draft = { ...emptyDraft(), name: "api", command: "bun run api", env: [{ key: "T", value: "ab", secret: true }] };
    expect(editorProblems(undefined, draft).some((problem) => problem.message.includes("4 characters"))).toBe(true);
  });
});

describe("when a problem is shown", () => {
  /** A brand-new configuration: invalid by construction, because nothing has
   *  been typed yet. */
  const blank = () => editorProblems(undefined, emptyDraft());

  test("an untouched form says nothing, however wrong it is", () => {
    // The editor opened with "Give this configuration a name." already in red,
    // addressed to somebody whose cursor had not reached the first box.
    expect(blank().length).toBeGreaterThan(0);
    expect(visibleProblems(blank(), {}, false)).toEqual([]);
  });

  test("leaving a field is what lets its own complaint speak — and only its own", () => {
    const shown = visibleProblems(blank(), { name: true }, false);
    expect(shown.map((problem) => problem.field)).toEqual(["name"]);
    expect(shown[0]?.message).toBe("Give this configuration a name.");
  });

  test("pressing Save asks to be told everything", () => {
    // Save stays pressable precisely so this is reachable: a disabled button on
    // a form hiding its complaints does nothing for a reason it will not give.
    expect(visibleProblems(blank(), {}, true)).toEqual(blank());
  });

  test("a valid form has nothing to show either way", () => {
    const good = editorProblems(undefined, { ...emptyDraft(), name: "web", command: "bun run dev" });
    expect(visibleProblems(good, { name: true, command: true }, true)).toEqual([]);
  });
});
