/**
 * Subjects — the record that ends one noun doing three jobs.
 *
 * `SpoolItem.project` was a free-form string, so the module had nowhere to put
 * facts about a project's SHAPE and put them in items instead. That is how
 * `hito 1 cierra en dos semanas` — a milestone's closing date — ended up on the
 * desk as a piece of work, and why a drafting pass over it spent all five of its
 * questions asking for the record type that did not exist.
 *
 * TWO CLAIMS ARE LOAD-BEARING HERE and both are asserted rather than described:
 * the migration touches no packet, and `permits` actually gates the night.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SpoolItem } from "@telar/engine-client";
import {
  deriveSubjects,
  ensureSubject,
  findSubject,
  isAddressableKey,
  isRepoAddress,
  readSubjects,
  setSubjectIdentity,
  setSubjectPermits,
  setSubjectTerrain,
  SUBJECT_AREA_MAX,
  subjectPermits,
  subjectsPath,
} from "../src/spool/subjects";
import { effectivePermits } from "../src/spool/areas";
import { createItem, ensureSpool, spoolPaths, type SpoolPaths } from "../src/spool/store";
import { planNight } from "../src/spool/night";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "telar-spool-subjects-"));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

let paths: SpoolPaths;
let seq = 0;

beforeEach(() => {
  const engineRoot = path.join(ROOT, `run-${++seq}`);
  fs.mkdirSync(engineRoot, { recursive: true });
  paths = spoolPaths(engineRoot);
  ensureSpool(paths);
});

const seedItem = (title: string, project?: string) =>
  createItem(paths, { title, provenance: "typed", ...(project ? { project } : {}), raw: `${title} — shorthand` });

describe("the migration derives subjects from what is already on disk", () => {
  test("one subject per distinct project, and NOT one per item", () => {
    seedItem("presupuestos sept no cuadran", "ozom-gv");
    seedItem("paridad supermetrics vs apis", "ozom-gv");
    seedItem("Rework onboarding flow", "aurora");

    const { created } = deriveSubjects(paths);

    expect(created.map((s) => s.key).sort()).toEqual(["aurora", "ozom-gv"]);
    expect(readSubjects(paths)).toHaveLength(2);
  });

  /**
   * "floating" IS A RENDERING OF ABSENCE, never a stored value — three surfaces
   * spell `item.project ?? "floating"`. A subject by that name would be this
   * migration inventing one, and it is exactly the mistake a first draft of this
   * plan made.
   */
  test("an item with no project produces NO subject", () => {
    seedItem("Call María — invoice");
    seedItem("presupuestos sept no cuadran", "ozom-gv");

    deriveSubjects(paths);

    expect(readSubjects(paths).map((s) => s.key)).toEqual(["ozom-gv"]);
    expect(findSubject(paths, "floating")).toBeUndefined();
  });

  /** The whole reason the item shape did not change: no packet migration, no
   *  `SPOOL_ITEM_SCHEMA_VERSION` bump, nothing to get wrong. */
  test("it does not touch a single packet", () => {
    const item = seedItem("presupuestos sept no cuadran", "ozom-gv");
    const file = path.join(paths.packets, item.id, "packet.json");
    const before = fs.readFileSync(file, "utf8");
    const mtime = fs.statSync(file).mtimeMs;

    deriveSubjects(paths);

    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });

  test("running it twice creates nothing the second time", () => {
    seedItem("a", "ozom-gv");
    expect(deriveSubjects(paths).created).toHaveLength(1);
    expect(deriveSubjects(paths).created).toHaveLength(0);
    expect(readSubjects(paths)).toHaveLength(1);
  });

  /** A checkout is something a subject HAS, never what it IS — so the two cases
   *  differ from the first write rather than after someone notices. */
  test("a subject whose name matches a registered project is linked; one that does not is not", () => {
    seedItem("a", "ozom-gv");
    seedItem("b", "aurora");

    deriveSubjects(paths, [{ id: "project_123", name: "ozom-gv" }]);

    expect(findSubject(paths, "ozom-gv")!.projectId).toBe("project_123");
    expect(findSubject(paths, "aurora")!.projectId).toBeUndefined();
  });

  /**
   * Such an item ALREADY cannot have an expert — `runExpertPass` refuses it by
   * the same rule — so failing the whole migration over one would turn an
   * existing, reported condition into a startup crash.
   */
  test("a name the store cannot address is reported and stepped over", () => {
    seedItem("a", "My Project");
    seedItem("b", "ozom-gv");

    const { created, skipped } = deriveSubjects(paths);

    expect(created.map((s) => s.key)).toEqual(["ozom-gv"]);
    expect(skipped).toEqual(["My Project"]);
  });

  test("the guard agrees with the one the digest path already applies", () => {
    expect(isAddressableKey("ozom-gv")).toBe(true);
    expect(isAddressableKey("telar_vnext.2")).toBe(true);
    expect(isAddressableKey("My Project")).toBe(false);
    expect(isAddressableKey("../escape")).toBe(false);
    expect(isAddressableKey(".hidden")).toBe(false);
    expect(isAddressableKey(undefined)).toBe(false);
  });

  /** Tolerant per ROW like `readLanes`, and for the same stated reason: a human
   *  who hand-edits this file and breaks one row must not lose every subject. */
  test("one broken row does not cost the others", () => {
    fs.writeFileSync(
      subjectsPath(paths),
      JSON.stringify([
        { key: "ozom-gv", name: "ozom-gv", permits: "draft", created: "Fri", schemaVersion: 1 },
        { key: 42 },
        { key: "aurora", name: "aurora", permits: "read", created: "Fri", schemaVersion: 1 },
      ]),
    );
    expect(readSubjects(paths).map((s) => s.key)).toEqual(["ozom-gv", "aurora"]);
  });
});

describe("registering a subject", () => {
  /** Defaulting lower would change what the night does the moment this lands,
   *  silently — the one thing a migration must not do. */
  test("it defaults to `draft`, which is exactly today's behaviour", () => {
    expect(ensureSubject(paths, "ozom-gv").permits).toBe("draft");
  });

  test("ensuring twice returns the first, never a duplicate", () => {
    const first = ensureSubject(paths, "ozom-gv");
    const second = ensureSubject(paths, "ozom-gv", { name: "something else" });
    expect(second.created).toBe(first.created);
    expect(second.name).toBe(first.name);
    expect(readSubjects(paths)).toHaveLength(1);
  });

  test("a name the store cannot address is refused, and says why", () => {
    expect(() => ensureSubject(paths, "My Project")).toThrow(/plain slug/);
  });

  test("permits can be changed, and an unknown key answers null", () => {
    ensureSubject(paths, "ozom-gv");
    expect(setSubjectPermits(paths, "ozom-gv", "read")!.permits).toBe("read");
    expect(findSubject(paths, "ozom-gv")!.permits).toBe("read");
    expect(setSubjectPermits(paths, "nope", "read")).toBeNull();
  });
});

/**
 * TERRAIN — a subject may know where it lives; most never will, and both are
 * first-class. The repo guard is the one place a human-stated string is
 * validated before it can ever reach a `gh` argv.
 */
describe("terrain", () => {
  test("set, read back, and clear — clearing is a corrected statement, not a delete path", () => {
    ensureSubject(paths, "ozom-gv");
    const set = setSubjectTerrain(paths, "ozom-gv", {
      kind: "github-repo",
      repo: "ozom-ai/ozom-gv",
      notes: "milestones are Hitos; needs-approval is the accept gate",
    })!;
    expect(set.terrain).toEqual({
      kind: "github-repo",
      repo: "ozom-ai/ozom-gv",
      notes: "milestones are Hitos; needs-approval is the accept gate",
    });
    expect(findSubject(paths, "ozom-gv")!.terrain!.repo).toBe("ozom-ai/ozom-gv");

    const cleared = setSubjectTerrain(paths, "ozom-gv", null)!;
    expect(cleared.terrain).toBeUndefined();
    // Everything else about the subject survives the withdrawal.
    expect(cleared.permits).toBe("draft");
    expect(findSubject(paths, "ozom-gv")!.terrain).toBeUndefined();
  });

  test("a subject with no terrain is untouched and fully ordinary", () => {
    const school = ensureSubject(paths, "school");
    expect(school.terrain).toBeUndefined();
    expect(subjectPermits(effectivePermits(school, []), "draft")).toBe(true);
  });

  test("an address gh could misread is refused loudly, and nothing is written", () => {
    ensureSubject(paths, "ozom-gv");
    // The string goes into `gh -R` verbatim, so the guard is strict: one
    // slash, plain slugs, no leading dash.
    expect(() => setSubjectTerrain(paths, "ozom-gv", { kind: "github-repo", repo: "not a repo" })).toThrow(/owner\/name/);
    expect(() => setSubjectTerrain(paths, "ozom-gv", { kind: "github-repo", repo: "-flag/attack" })).toThrow(/owner\/name/);
    expect(() =>
      setSubjectTerrain(paths, "ozom-gv", { kind: "directory", path: "/tmp" } as never),
    ).toThrow(/github-repo/);
    expect(findSubject(paths, "ozom-gv")!.terrain).toBeUndefined();

    expect(isRepoAddress("ozom-ai/ozom-gv")).toBe(true);
    expect(isRepoAddress("a/b/c")).toBe(false);
    expect(isRepoAddress("--repo/x")).toBe(false);
  });

  test("an unknown subject answers null", () => {
    expect(setSubjectTerrain(paths, "nope", { kind: "github-repo", repo: "a/b" })).toBeNull();
  });
});

/**
 * IDENTITY — whose a subject is: the user's own group name (`area`) and a hue
 * from the closed token set (`color`). Identity, never state: no test here may
 * ever relate a color to a deadline, a lane or a priority, because no code may.
 */
describe("identity — area and color", () => {
  test("set both in one statement, read back, and clear each — clearing withdraws, it deletes nothing", () => {
    ensureSubject(paths, "casa");
    const set = setSubjectIdentity(paths, "casa", { area: "Personal", color: "sea" })!;
    expect(set.area).toBe("Personal");
    expect(set.color).toBe("sea");
    expect(findSubject(paths, "casa")).toMatchObject({ area: "Personal", color: "sea" });

    // One field at a time leaves the other exactly where the user put it.
    const recolored = setSubjectIdentity(paths, "casa", { color: "plum" })!;
    expect(recolored.area).toBe("Personal");
    expect(recolored.color).toBe("plum");

    const noColor = setSubjectIdentity(paths, "casa", { color: null })!;
    expect(noColor.color).toBeUndefined();
    expect(noColor.area).toBe("Personal");

    const noArea = setSubjectIdentity(paths, "casa", { area: null })!;
    expect(noArea.area).toBeUndefined();
    // Everything else about the subject survives the withdrawal.
    expect(noArea.permits).toBe("draft");
    expect(findSubject(paths, "casa")!.name).toBe("casa");
  });

  test("the area is the user's word, trimmed — and an empty or overlong one is refused with nothing written", () => {
    ensureSubject(paths, "casa");
    expect(setSubjectIdentity(paths, "casa", { area: "  Trabajo  " })!.area).toBe("Trabajo");

    expect(() => setSubjectIdentity(paths, "casa", { area: "   " })).toThrow(/`null` to clear/);
    expect(() => setSubjectIdentity(paths, "casa", { area: "x".repeat(SUBJECT_AREA_MAX + 1) })).toThrow(/short group name/);
    expect(() => setSubjectIdentity(paths, "casa", { area: 7 as never })).toThrow(/user's own words/);
    expect(findSubject(paths, "casa")!.area).toBe("Trabajo");
  });

  test("color is a CLOSED set of identity tokens — free hex is refused, and the sentence names the law", () => {
    ensureSubject(paths, "casa");
    expect(() => setSubjectIdentity(paths, "casa", { color: "#ff0000" as never })).toThrow(/never a hex value/);
    expect(() => setSubjectIdentity(paths, "casa", { color: "red" as never })).toThrow(/never a signal of urgency/);
    expect(findSubject(paths, "casa")!.color).toBeUndefined();
  });

  test("an empty patch is refused, an unknown subject answers null, and a subject with no identity is fully ordinary", () => {
    ensureSubject(paths, "school");
    expect(() => setSubjectIdentity(paths, "school", {})).toThrow(/Name what to change/);
    expect(setSubjectIdentity(paths, "nope", { area: "Trabajo" })).toBeNull();
    expect(findSubject(paths, "school")).not.toHaveProperty("area");
    expect(findSubject(paths, "school")).not.toHaveProperty("color");
  });
});

/**
 * §7.6 IS NOT DECORATIVE — it gates the night, which is the first thing the
 * Subject record does rather than describes.
 */
describe("permits gate the night's plan", () => {
  const item = (over: Partial<SpoolItem> & { id: string; title: string }): SpoolItem => ({
    provenance: "typed",
    captured: "Fri 22:00",
    schemaVersion: 1,
    ...over,
  });

  const shorthand = item({ id: "i-1", title: "raw one", project: "ozom-gv", raw: "x" });
  const briefed = item({ id: "i-2", title: "briefed one", project: "ozom-gv", fixed: "a brief" });

  const gate = (permits: "read" | "draft" | "propose") => (_key: string | undefined, level: "read" | "draft") =>
    subjectPermits(effectivePermits({ key: "ozom-gv", name: "ozom-gv", permits, created: "Fri", schemaVersion: 1 }, []), level);

  test("`read` ripens and never drafts", () => {
    const plan = planNight([shorthand, briefed], gate("read"));
    expect(plan.map((j) => j.kind)).toEqual(["ripen"]);
  });

  test("`draft` does both — today's behaviour", () => {
    const plan = planNight([shorthand, briefed], gate("draft"));
    expect(plan.map((j) => j.kind)).toEqual(["ripen", "draft"]);
  });

  test("`propose` contains everything below it", () => {
    expect(planNight([shorthand, briefed], gate("propose")).map((j) => j.kind)).toEqual(["ripen", "draft"]);
  });

  /** A caller that has not been updated must not silently stop working, so the
   *  parameter is optional and absent means permitted. */
  test("with no gate at all, nothing changes", () => {
    expect(planNight([shorthand, briefed]).map((j) => j.kind)).toEqual(["ripen", "draft"]);
  });

  /**
   * A name nothing has registered yet is the state EVERY item was in before this
   * record existed. Refusing outright would make the migration's own gap look
   * like a policy decision the user never made.
   */
  test("an unregistered subject is treated as its floor, not as forbidden", () => {
    expect(subjectPermits(effectivePermits(undefined, []), "read")).toBe(true);
    expect(subjectPermits(effectivePermits(undefined, []), "draft")).toBe(false);
  });
});
