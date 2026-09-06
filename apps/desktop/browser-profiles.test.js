const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { partitionFor, readMapping, writeMapping, LEGACY_PARTITION } = require("./browser-profiles");

// Synthetic ids, the shape the engine mints (project_ + 32 hex).
const A = "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("browser profiles", () => {
  test("each project gets its own partition; a missing key is refused, never defaulted", () => {
    const none = { legacyOwnerProjectId: null };
    expect(partitionFor(A, none)).toBe("persist:telar-project-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(partitionFor(B, none)).not.toBe(partitionFor(A, none));
    expect(() => partitionFor(undefined, none)).toThrow(/required/);
    expect(() => partitionFor("", none)).toThrow(/required/);
    expect(() => partitionFor("session_abc", none)).toThrow(/project id/);
    // The explicit projectless key is its own clean partition, not legacy.
    expect(partitionFor("none", none)).toBe("persist:telar-profile-none");
  });
  test("the legacy partition is used only by its explicitly named owner", () => {
    const owned = { legacyOwnerProjectId: A };
    expect(partitionFor(A, owned)).toBe(LEGACY_PARTITION);
    expect(partitionFor(B, owned)).toBe("persist:telar-project-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(partitionFor("none", owned)).toBe("persist:telar-profile-none");
  });
  test("the mapping is a file the person writes once; absent means no owner, and reassigning needs force", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-profiles-"));
    expect(readMapping(dir).legacyOwnerProjectId).toBeNull();
    expect(writeMapping(dir, A).legacyOwnerProjectId).toBe(A);
    expect(() => writeMapping(dir, B)).toThrow(/already owned/);
    expect(writeMapping(dir, B, { force: true }).legacyOwnerProjectId).toBe(B);
    fs.writeFileSync(path.join(dir, "browser-profiles.json"), JSON.stringify({ legacyOwnerProjectId: "nope" }));
    expect(() => readMapping(dir)).toThrow(/project id/);
  });
});
