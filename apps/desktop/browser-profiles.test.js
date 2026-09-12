const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  ProfileRegistry,
  readProfileRegistry,
  legacyPartitionFor,
  readMapping,
  writeMapping,
  LEGACY_PARTITION,
  FILE_NAME,
  DEFAULT_PROFILE_LABEL,
} = require("./browser-profiles");

// Synthetic ids, the shape the engine mints (project_ + 32 hex).
const A = "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "project_cccccccccccccccccccccccccccccccc";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "telar-profiles-"));
}

/** A registry with predictable ids, and a settable set of partitions that
 *  "already exist on disk" — the migration signal. */
function registry(dir, existing = []) {
  let next = 0;
  const partitions = new Set(existing);
  return new ProfileRegistry(dir, {
    randomId: () => `bp_${String(++next).padStart(16, "0")}`,
    now: () => next,
    partitionExists: (partition) => partitions.has(partition),
  });
}

describe("the pre-profile partition map", () => {
  test("each project has its own; a missing key is refused, never defaulted", () => {
    const none = { legacyOwnerProjectId: null };
    expect(legacyPartitionFor(A, none)).toBe("persist:telar-project-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(legacyPartitionFor(B, none)).not.toBe(legacyPartitionFor(A, none));
    expect(() => legacyPartitionFor(undefined, none)).toThrow(/required/);
    expect(() => legacyPartitionFor("session_abc", none)).toThrow(/project id/);
    expect(legacyPartitionFor("none", none)).toBe("persist:telar-profile-none");
  });

  test("the legacy partition is used only by its explicitly named owner", () => {
    const owned = { legacyOwnerProjectId: A };
    expect(legacyPartitionFor(A, owned)).toBe(LEGACY_PARTITION);
    expect(legacyPartitionFor(B, owned)).not.toBe(LEGACY_PARTITION);
  });

  test("the legacy owner is a file the person writes once; reassigning needs force", () => {
    const dir = tmp();
    expect(readMapping(dir).legacyOwnerProjectId).toBeNull();
    expect(writeMapping(dir, A).legacyOwnerProjectId).toBe(A);
    expect(() => writeMapping(dir, B)).toThrow(/already owned/);
    expect(writeMapping(dir, B, { force: true }).legacyOwnerProjectId).toBe(B);
    fs.writeFileSync(path.join(dir, FILE_NAME), JSON.stringify({ legacyOwnerProjectId: "nope" }));
    expect(() => readMapping(dir)).toThrow(/project id/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("named, reusable profiles", () => {
  test("a profile is a labelled identity with its own partition; several projects may share one", () => {
    const dir = tmp();
    const store = registry(dir);
    const work = store.create({ label: "Work", account: "me@work.example" });
    expect(work.id).toMatch(/^bp_[a-f0-9]{16}$/);
    expect(work.partition).toBe(`persist:telar-profile-${work.id}`);
    expect(work.account).toBe("me@work.example");
    // "Default" was already there and stays the default; a profile a person
    // creates does not quietly take over where every other project browses.
    expect(work.isDefault).toBe(false);
    expect(store.get(store.defaultProfileId).label).toBe(DEFAULT_PROFILE_LABEL);

    store.assign(A, work.id);
    store.assign(B, work.id);
    expect(store.resolve(A).partition).toBe(work.partition);
    expect(store.resolve(B).partition).toBe(work.partition);
    expect(store.projectsOf(work.id).sort()).toEqual([A, B]);

    // A distinct profile is a distinct jar — sharing is opt-in, both ways.
    const personal = store.create({ label: "Personal" });
    store.assign(B, personal.id);
    expect(store.resolve(B).partition).not.toBe(work.partition);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("labels and expected accounts are editable; the partition never moves with them", () => {
    const dir = tmp();
    const store = registry(dir);
    const made = store.create({ label: "  Work   Mail " });
    expect(made.label).toBe("Work Mail");
    const renamed = store.update(made.id, { label: "Job", account: "a@b.example" });
    expect(renamed.label).toBe("Job");
    expect(renamed.partition).toBe(made.partition);
    // The account is INTENT: clearing it is allowed and proves no login.
    expect(store.update(made.id, { account: "" }).account).toBeUndefined();
    expect(() => store.update(made.id, { label: "" })).toThrow(/label is required/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("first run makes exactly one profile, called Default, and marks it default", () => {
    const dir = tmp();
    const store = registry(dir);
    expect(store.list().map((profile) => profile.label)).toEqual([DEFAULT_PROFILE_LABEL]);
    expect(store.get(store.defaultProfileId).label).toBe(DEFAULT_PROFILE_LABEL);
    // Opening it again adopts what is there rather than making a second one.
    const reopened = readProfileRegistry(dir);
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.defaultProfileId).toBe(store.defaultProfileId);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("the ladder: assignment, then an existing jar, then the default — nothing is minted per project", () => {
    const dir = tmp();
    const existing = "persist:telar-project-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const store = registry(dir, [existing]);
    const shared = store.create({ label: "Shared" });
    store.setDefault(shared.id);

    // A: has cookies from before profiles → keeps THAT jar, not the default.
    const migrated = store.resolve(A);
    expect(migrated.partition).toBe(existing);
    expect(migrated.id).not.toBe(shared.id);
    expect(store.migrations).toEqual([{ from: A, to: migrated.id }]);

    // B: brand new → joins the global default.
    expect(store.resolve(B).id).toBe(shared.id);

    // A project with no history of its own gets the DEFAULT, never a jar of its
    // own: two such projects share one identity and one sign-in.
    const bare = registry(tmp());
    expect(bare.resolve(C).id).toBe(bare.defaultProfileId);
    expect(bare.resolve(B).id).toBe(bare.resolve(C).id);
    expect(bare.list()).toHaveLength(1);
    // And landing on the default is NOT written down as an assignment, so
    // changing the default moves every project that never picked one.
    expect(bare.assignmentOf(C)).toBeNull();
    const moved = bare.create({ label: "Second" });
    bare.setDefault(moved.id);
    expect(bare.resolve(C).id).toBe(moved.id);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("migration keeps each project's own jar, assigned, listed, and never the default", () => {
    const dir = tmp();
    const store = registry(dir, [
      "persist:telar-project-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "persist:telar-project-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
    const first = store.resolve(A);
    const second = store.resolve(B);
    // Kept, distinct, and left assigned to the project whose cookies they hold.
    expect(first.id).not.toBe(second.id);
    expect(store.assignmentOf(A)).toBe(first.id);
    expect(store.assignmentOf(B)).toBe(second.id);
    // Otherwise every later project would land in the first one's cookies.
    expect(store.defaultProfileId).not.toBe(first.id);
    expect(store.defaultProfileId).not.toBe(second.id);
    // Listed in the pane, under names that say what they are rather than which
    // project id they came from — the person renames them from there.
    const labels = store.list().map((profile) => profile.label);
    expect(labels).toContain(DEFAULT_PROFILE_LABEL);
    expect(labels).toContain("Earlier sign-ins");
    expect(labels).toContain("Earlier sign-ins 2");
    for (const label of labels) expect(label).not.toMatch(/^Project /);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a profile is deleted only when nothing points at it; the jar on disk is left alone", () => {
    const dir = tmp();
    const store = registry(dir);
    const spare = store.create({ label: "Spare" });
    const used = store.create({ label: "Used" });
    store.assign(A, used.id);

    expect(() => store.remove(store.defaultProfileId)).toThrow(/default profile/);
    expect(() => store.remove(used.id)).toThrow(/used by 1 project/);
    expect(store.remove(spare.id).label).toBe("Spare");
    expect(store.get(spare.id)).toBeNull();
    // Forgetting the record never touches the partition directory, so the
    // surviving profiles' jars are unaffected and the default still resolves.
    expect(store.resolve(A).id).toBe(used.id);
    expect(readProfileRegistry(dir).list().map((profile) => profile.label)).toEqual([DEFAULT_PROFILE_LABEL, "Used"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("the legacy jar migrates to a profile of its own, still owned by one project", () => {
    const dir = tmp();
    writeMapping(dir, A);
    const store = registry(dir, [LEGACY_PARTITION]);
    expect(store.resolve(A).partition).toBe(LEGACY_PARTITION);
    expect(store.resolve(B).partition).not.toBe(LEGACY_PARTITION);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("assignments, labels and the default survive a restart; a dangling reference is an error, not a guess", () => {
    const dir = tmp();
    const store = registry(dir);
    const work = store.create({ label: "Work", account: "me@work.example" });
    store.assign(A, work.id);

    const reopened = readProfileRegistry(dir);
    expect(reopened.list().map((profile) => profile.label)).toEqual([DEFAULT_PROFILE_LABEL, "Work"]);
    expect(reopened.defaultProfileId).toBe(store.defaultProfileId);
    expect(reopened.resolve(A).id).toBe(work.id);
    expect(reopened.get(work.id).account).toBe("me@work.example");

    expect(() => reopened.require("bp_00000000000000ff")).toThrow(/No browser profile/);
    // A file naming a profile that is gone drops the ASSIGNMENT (the ladder
    // decides again) rather than resolving into some other identity's cookies.
    fs.writeFileSync(
      path.join(dir, FILE_NAME),
      JSON.stringify({ version: 2, defaultProfileId: null, profiles: {}, projects: { [A]: "bp_00000000000000ff" } }),
    );
    const repaired = registry(dir);
    expect(repaired.assignmentOf(A)).toBeNull();
    expect(repaired.resolve(A).id).toBe(repaired.defaultProfileId);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a project removed from the registry and re-registered under the same id keeps its identity", () => {
    // The engine may forget a project (a removed registration) and take it
    // back later. NOTHING here reacts to that: profiles are keyed by the
    // project's own stable id and no cookie jar is ever removed, so the same
    // id resolves to the same profile and the same partition afterwards. A
    // re-registration under a NEW id is a new project, and lands on the
    // default — which is the honest answer, not a silent adoption of another
    // project's cookies.
    const dir = tmp();
    const store = registry(dir);
    const work = store.create({ label: "Work" });
    store.assign(A, work.id);
    const before = store.resolve(A);

    const afterRemoval = readProfileRegistry(dir);
    expect(afterRemoval.resolve(A)).toEqual(before);
    expect(afterRemoval.get(work.id).partition).toBe(work.partition);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("an ephemeral registry (no userData) resolves but writes nothing", () => {
    const store = new ProfileRegistry(null);
    // It still has a default — in memory, for this process only — so a scope
    // with no project resolves to a real partition instead of failing closed.
    expect(store.list().map((profile) => profile.label)).toEqual([DEFAULT_PROFILE_LABEL]);
    expect(store.resolve("none").id).toBe(store.defaultProfileId);
    expect(store.file).toBeNull();
  });
});
