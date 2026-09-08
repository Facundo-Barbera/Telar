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
    // The first profile a PERSON creates becomes the default.
    expect(work.isDefault).toBe(true);

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

  test("the ladder: assignment, then an existing jar, then the default, then a fresh per-project profile", () => {
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

    // With no default at all, a new project gets its own clean jar (the
    // pre-profile behaviour, unchanged).
    const bare = registry(tmp());
    expect(bare.resolve(C).partition).toBe(`persist:telar-project-${C.slice("project_".length)}`);
    expect(bare.defaultProfileId).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a jar the ladder adopted never becomes the global default", () => {
    const dir = tmp();
    const store = registry(dir, ["persist:telar-project-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
    store.resolve(A);
    store.resolve(B);
    // Otherwise every later project would land in the first one's cookies.
    expect(store.defaultProfileId).toBeNull();
    expect(store.resolve(A).id).not.toBe(store.resolve(B).id);
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
    expect(reopened.list().map((profile) => profile.label)).toEqual(["Work"]);
    expect(reopened.defaultProfileId).toBe(work.id);
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
    expect(repaired.resolve(A).partition).toBe(`persist:telar-project-${A.slice("project_".length)}`);
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
    expect(store.resolve("none").partition).toBe("persist:telar-profile-none");
    expect(store.file).toBeNull();
  });
});
