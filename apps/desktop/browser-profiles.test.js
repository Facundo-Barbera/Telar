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
  PROFILE_COLORS,
} = require("./browser-profiles");

const A = "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "project_cccccccccccccccccccccccccccccccc";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "telar-profiles-"));
}

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

    expect(work.isDefault).toBe(false);
    expect(store.get(store.defaultProfileId).label).toBe(DEFAULT_PROFILE_LABEL);

    store.assign(A, work.id);
    store.assign(B, work.id);
    expect(store.resolve(A).partition).toBe(work.partition);
    expect(store.resolve(B).partition).toBe(work.partition);
    expect(store.projectsOf(work.id).sort()).toEqual([A, B]);

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

    expect(store.update(made.id, { account: "" }).account).toBeUndefined();
    expect(() => store.update(made.id, { label: "" })).toThrow(/label is required/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("first run makes exactly one profile, called Default, and marks it default", () => {
    const dir = tmp();
    const store = registry(dir);
    expect(store.list().map((profile) => profile.label)).toEqual([DEFAULT_PROFILE_LABEL]);
    expect(store.get(store.defaultProfileId).label).toBe(DEFAULT_PROFILE_LABEL);

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

    const migrated = store.resolve(A);
    expect(migrated.partition).toBe(existing);
    expect(migrated.id).not.toBe(shared.id);
    expect(store.migrations).toEqual([{ from: A, to: migrated.id }]);

    expect(store.resolve(B).id).toBe(shared.id);

    const bare = registry(tmp());
    expect(bare.resolve(C).id).toBe(bare.defaultProfileId);
    expect(bare.resolve(B).id).toBe(bare.resolve(C).id);
    expect(bare.list()).toHaveLength(1);

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

    expect(first.id).not.toBe(second.id);
    expect(store.assignmentOf(A)).toBe(first.id);
    expect(store.assignmentOf(B)).toBe(second.id);

    expect(store.defaultProfileId).not.toBe(first.id);
    expect(store.defaultProfileId).not.toBe(second.id);

    const labels = store.list().map((profile) => profile.label);
    expect(labels).toContain(DEFAULT_PROFILE_LABEL);
    expect(labels).toContain("Earlier sign-ins");
    expect(labels).toContain("Earlier sign-ins 2");
    for (const label of labels) expect(label).not.toMatch(/^Project /);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("any profile but the default is deleted, its projects fall back to the default, and the jar on disk is left alone", () => {
    const dir = tmp();
    const store = registry(dir);
    const spare = store.create({ label: "Spare" });
    const used = store.create({ label: "Used" });
    store.assign(A, used.id);
    store.assign(B, used.id);

    expect(() => store.remove(store.defaultProfileId)).toThrow(/default profile/);

    expect(store.remove(spare.id).label).toBe("Spare");
    expect(store.get(spare.id)).toBeNull();

    const removed = store.remove(used.id);
    expect(removed.label).toBe("Used");
    expect(removed.projects.sort()).toEqual([A, B].sort());
    expect(store.get(used.id)).toBeNull();

    expect(store.assignmentOf(A)).toBeNull();
    expect(store.resolve(A).id).toBe(store.defaultProfileId);
    expect(store.resolve(B).id).toBe(store.defaultProfileId);

    expect(readProfileRegistry(dir).list().map((profile) => profile.label)).toEqual([DEFAULT_PROFILE_LABEL]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("deleting a profile leaves a migrated project on its own jar, not on the default", () => {
    const dir = tmp();
    const store = registry(dir, ["persist:telar-project-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
    const adopted = store.resolve(A);
    const work = store.create({ label: "Work" });
    store.assign(A, work.id);

    store.remove(work.id);
    expect(store.resolve(A).id).toBe(adopted.id);
    expect(store.resolve(A).id).not.toBe(store.defaultProfileId);
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

    expect(store.list().map((profile) => profile.label)).toEqual([DEFAULT_PROFILE_LABEL]);
    expect(store.resolve("none").id).toBe(store.defaultProfileId);
    expect(store.file).toBeNull();
  });
});

describe("a profile's icon and colour", () => {
  test("a profile has neither until someone chooses, and choosing is not renaming", () => {
    const dir = tmp();
    const store = registry(dir);
    const work = store.create({ label: "Work" });
    expect(work.icon).toBeUndefined();
    expect(work.color).toBeUndefined();

    const marked = store.update(work.id, { icon: "briefcase", color: "amber" });
    expect(marked).toMatchObject({ label: "Work", icon: "briefcase", color: "amber" });

    expect(store.update(work.id, { color: "sea" })).toMatchObject({ label: "Work", icon: "briefcase", color: "sea" });
    expect(store.update(work.id, { label: "Work travel" })).toMatchObject({ label: "Work travel", icon: "briefcase", color: "sea" });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("they can be created with, and taken off again", () => {
    const dir = tmp();
    const store = registry(dir);
    const personal = store.create({ label: "Personal", icon: "house", color: "moss" });
    expect(personal).toMatchObject({ icon: "house", color: "moss" });

    const bare = store.update(personal.id, { icon: null, color: null });
    expect(bare.icon).toBeUndefined();
    expect(bare.color).toBeUndefined();
    expect(bare.label).toBe("Personal");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a colour outside the eight, or an icon that is not an icon id, is refused by name", () => {
    const store = new ProfileRegistry(null);
    const profile = store.create({ label: "Work" });
    expect(() => store.update(profile.id, { color: "chartreuse" })).toThrow(/colour must be one of/);
    expect(() => store.update(profile.id, { color: "#ff0000" })).toThrow(/colour must be one of/);

    expect(() => store.update(profile.id, { icon: "🏠" })).toThrow(/lucide icon id/);
    expect(() => store.update(profile.id, { icon: "a house, please" })).toThrow(/lucide icon id/);
    expect(() => store.create({ label: "Bad", color: "puce" })).toThrow(/colour must be one of/);

    expect(store.get(profile.id)).toMatchObject({ label: "Work" });
    expect(store.get(profile.id).color).toBeUndefined();
  });

  test("the eight the registry accepts are the eight the app paints with", () => {
    expect(PROFILE_COLORS).toEqual(["plum", "sea", "moss", "amber", "slate", "rose", "sky", "sand"]);
    const store = new ProfileRegistry(null);
    const profile = store.create({ label: "Work" });
    for (const color of PROFILE_COLORS) expect(store.update(profile.id, { color }).color).toBe(color);
  });

  test("the marks survive a reopen, and a hand-edited one is dropped rather than fatal", () => {
    const dir = tmp();
    const store = registry(dir);
    const work = store.create({ label: "Work", icon: "briefcase", color: "amber" });
    expect(readProfileRegistry(dir).get(work.id)).toMatchObject({ icon: "briefcase", color: "amber" });

    const document = JSON.parse(fs.readFileSync(path.join(dir, FILE_NAME), "utf8"));
    document.profiles[work.id].color = "chartreuse";
    document.profiles[work.id].icon = "🏠";
    fs.writeFileSync(path.join(dir, FILE_NAME), JSON.stringify(document));

    const reopened = readProfileRegistry(dir).get(work.id);
    expect(reopened).toMatchObject({ label: "Work", partition: work.partition });
    expect(reopened.color).toBeUndefined();
    expect(reopened.icon).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
