import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-bundle-"));
process.env.TELAR_HOME = home;
// bun test runs all files in one process — re-pin the env before every test
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const {
  CONTRACT_FILE,
  PROVENANCE_FILE,
  bundleVersion,
  listBundleFiles,
  quickBundle,
  readBundleFile,
  readContract,
  readProvenance,
  snapshotBundle,
  specDir,
  writeBundleFile,
  writeContract,
} = await import("../src/bundle");
const { createLoom, getLoom, saveLoom } = await import("../src/looms");

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function newLoomId(): string {
  return createLoom({ project: "p", kind: "custom", title: "t", prompt: "x", account: "personal" }).id;
}

describe("bundle file I/O", () => {
  test("writeBundleFile/readBundleFile roundtrip, nested dirs auto-created", () => {
    const id = newLoomId();
    writeBundleFile(id, "notes/plan.md", "the plan");
    expect(readBundleFile(id, "notes/plan.md")).toBe("the plan");
    expect(fs.existsSync(path.join(specDir(id), "notes", "plan.md"))).toBe(true);
  });

  test("readBundleFile returns null for a missing file", () => {
    const id = newLoomId();
    expect(readBundleFile(id, "nope.md")).toBeNull();
  });

  test("listBundleFiles returns [] for an empty bundle", () => {
    const id = newLoomId();
    expect(listBundleFiles(id)).toEqual([]);
  });

  test("listBundleFiles is recursive and sorted", () => {
    const id = newLoomId();
    writeBundleFile(id, "b.md", "b");
    writeBundleFile(id, "sub/a.md", "a");
    writeBundleFile(id, "a.md", "a");
    expect(listBundleFiles(id)).toEqual(["a.md", "b.md", "sub/a.md"]);
  });

  test("rejects a relPath that escapes spec/ via ..", () => {
    const id = newLoomId();
    expect(() => writeBundleFile(id, "a/../../x", "x")).toThrow();
    expect(() => writeBundleFile(id, "../x", "x")).toThrow();
    expect(() => readBundleFile(id, "../x")).toThrow();
  });

  test("rejects an absolute relPath", () => {
    const id = newLoomId();
    expect(() => writeBundleFile(id, "/etc/passwd", "x")).toThrow();
    expect(() => readBundleFile(id, "/etc/passwd")).toThrow();
  });

  test("rejects an empty or self-referential relPath (would turn spec/ into a file)", () => {
    const id = newLoomId();
    expect(() => writeBundleFile(id, "", "x")).toThrow();
    expect(() => writeBundleFile(id, ".", "x")).toThrow();
    // spec/ must still be usable as a directory afterward
    writeBundleFile(id, "a.md", "a");
    expect(listBundleFiles(id)).toEqual(["a.md"]);
  });
});

describe("bundleVersion", () => {
  test("stable when unchanged, changes on any edit", () => {
    const id = newLoomId();
    writeBundleFile(id, "a.md", "hello");
    const v1 = bundleVersion(id);
    expect(bundleVersion(id)).toBe(v1);
    writeBundleFile(id, "a.md", "hello world");
    const v2 = bundleVersion(id);
    expect(v2).not.toBe(v1);
  });

  test("differs between distinct bundles with different content", () => {
    const id1 = newLoomId();
    const id2 = newLoomId();
    writeBundleFile(id1, "a.md", "x");
    writeBundleFile(id2, "a.md", "y");
    expect(bundleVersion(id1)).not.toBe(bundleVersion(id2));
  });
});

describe("snapshotBundle", () => {
  test("returns version + all files with contents", () => {
    const id = newLoomId();
    writeBundleFile(id, "a.md", "A");
    writeBundleFile(id, "sub/b.md", "B");
    const snap = snapshotBundle(id);
    expect(snap.version).toBe(bundleVersion(id));
    expect(snap.files).toEqual([
      { path: "a.md", contents: "A" },
      { path: "sub/b.md", contents: "B" },
    ]);
  });
});

describe("readContract", () => {
  test("returns errors, never throws, when contract.json is missing", () => {
    const id = newLoomId();
    const { contract, errors } = readContract(id);
    expect(contract).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });

  test("returns errors, never throws, on corrupt JSON", () => {
    const id = newLoomId();
    writeBundleFile(id, CONTRACT_FILE, "{ not json");
    const { contract, errors } = readContract(id);
    expect(contract).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });

  test("returns errors, never throws, when contract fails validateContract", () => {
    const id = newLoomId();
    writeBundleFile(id, CONTRACT_FILE, JSON.stringify({ version: 1, assertions: [] }));
    const { contract, errors } = readContract(id);
    expect(contract).toBeNull();
    expect(errors).toContain("contract must have at least one assertion");
  });

  test("parses a valid contract", () => {
    const id = newLoomId();
    const c = {
      version: 1,
      assertions: [
        { id: "a1", description: "checks x", type: "value-equality", expected: "42", blocker: true },
      ],
    };
    writeBundleFile(id, CONTRACT_FILE, JSON.stringify(c));
    const { contract, errors } = readContract(id);
    expect(errors).toEqual([]);
    expect(contract?.assertions[0]?.id).toBe("a1");
  });

  test("flags an expectedFile pointer that doesn't exist anywhere in the bundle", () => {
    const id = newLoomId();
    const c = {
      version: 1,
      assertions: [
        { id: "a1", description: "checks x", type: "golden-diff", expectedFile: "spec/golden.diff", blocker: true },
      ],
    };
    writeBundleFile(id, CONTRACT_FILE, JSON.stringify(c));
    const { contract, errors } = readContract(id);
    expect(contract).toBeNull();
    expect(errors.some((e) => e.includes("doesn't exist"))).toBe(true);
  });
});

describe("writeContract", () => {
  test("refuses a prose-only (non-falsifiable) contract", () => {
    const id = newLoomId();
    expect(() =>
      writeContract(id, {
        version: 1,
        assertions: [{ id: "a1", description: "should work", type: "value-equality", blocker: true }],
      }),
    ).toThrow();
    expect(readBundleFile(id, CONTRACT_FILE)).toBeNull();
  });

  test("writes pretty JSON for a valid contract", () => {
    const id = newLoomId();
    writeContract(id, {
      version: 1,
      assertions: [{ id: "a1", description: "checks x", type: "value-equality", expected: "42", blocker: true }],
    });
    const raw = readBundleFile(id, CONTRACT_FILE);
    expect(raw).toContain("\n"); // pretty-printed
    expect(JSON.parse(raw!).assertions[0].id).toBe("a1");
  });

  test("refuses an expectedFile pointer that doesn't exist in the bundle", () => {
    const id = newLoomId();
    expect(() =>
      writeContract(id, {
        version: 1,
        assertions: [
          { id: "a1", description: "checks x", type: "golden-diff", expectedFile: "spec/golden.diff", blocker: true },
        ],
      }),
    ).toThrow();
    expect(readBundleFile(id, CONTRACT_FILE)).toBeNull();
  });

  test("accepts an expectedFile pointer that does exist in the bundle", () => {
    const id = newLoomId();
    writeBundleFile(id, "spec/golden.diff", "the golden diff");
    expect(() =>
      writeContract(id, {
        version: 1,
        assertions: [
          { id: "a1", description: "checks x", type: "golden-diff", expectedFile: "spec/golden.diff", blocker: true },
        ],
      }),
    ).not.toThrow();
  });
});

describe("writeContract co-sign gate (§M.2 loosening on an already-started loom)", () => {
  const twoAssertions = {
    version: 1,
    assertions: [
      { id: "a1", description: "checks x", type: "value-equality" as const, expected: "42", blocker: true },
      { id: "a2", description: "checks y", type: "value-equality" as const, expected: "7", blocker: true },
    ],
  };

  test("removing an assertion on a started loom (draft:false) requires cosignedBy", () => {
    const id = newLoomId();
    writeContract(id, twoAssertions); // first write, before the loom has "started" — unrestricted
    const loom = getLoom(id)!;
    loom.draft = false; // simulates startLoomFromBundle having committed it
    saveLoom(loom);

    const loosened = { version: 1, assertions: [twoAssertions.assertions[0]!] }; // drops a2 outright
    expect(() => writeContract(id, loosened)).toThrow(/co-sign/);
    // rejected write must not persist — the original two-assertion contract stays in force
    expect(readContract(id).contract?.assertions.length).toBe(2);

    expect(() => writeContract(id, loosened, { cosignedBy: "bob" })).not.toThrow();
    expect(readContract(id).contract?.assertions.length).toBe(1);
  });

  test("tightening (adding an assertion) on a started loom needs no co-sign", () => {
    const id = newLoomId();
    writeContract(id, { version: 1, assertions: [twoAssertions.assertions[0]!] });
    const loom = getLoom(id)!;
    loom.draft = false;
    saveLoom(loom);

    expect(() => writeContract(id, twoAssertions)).not.toThrow();
  });

  test("a draft loom still being authored (draft:true) is unrestricted by the co-sign gate", () => {
    const id = newLoomId();
    writeContract(id, twoAssertions);
    const loom = getLoom(id)!;
    loom.draft = true; // still being authored — not yet committed via startLoomFromBundle
    saveLoom(loom);

    const loosened = { version: 1, assertions: [twoAssertions.assertions[0]!] };
    expect(() => writeContract(id, loosened)).not.toThrow();
  });

  test("a loom with no bundle-flow draft flag at all (draft undefined) is unrestricted", () => {
    const id = newLoomId(); // createLoom never sets `draft` unless asked
    writeContract(id, twoAssertions);
    const loosened = { version: 1, assertions: [twoAssertions.assertions[0]!] };
    expect(() => writeContract(id, loosened)).not.toThrow();
  });
});

describe("quickBundle", () => {
  const provenance = { approvedBy: "facundo", humanApprovedAt: Date.now() };

  test("writes objective.md, provenance.json, and a valid contract, no agent() call", () => {
    const id = newLoomId();
    const version = quickBundle(id, {
      objective: "fix the typo",
      assertions: [{ id: "a1", description: "typo fixed", type: "contains", expected: "hello", blocker: true }],
      provenance,
    });
    expect(readBundleFile(id, "objective.md")).toBe("fix the typo");
    const { contract, errors } = readContract(id);
    expect(errors).toEqual([]);
    expect(contract?.assertions.length).toBe(1);
    expect(version).toBe(bundleVersion(id));

    const { provenance: read, errors: pErrors } = readProvenance(id);
    expect(pErrors).toEqual([]);
    expect(read?.approvedBy).toBe(provenance.approvedBy);
  });

  test("rejects a non-falsifiable assertion set", () => {
    const id = newLoomId();
    expect(() =>
      quickBundle(id, {
        objective: "fix it",
        assertions: [{ id: "a1", description: "should be fixed", type: "value-equality", blocker: true }],
        provenance,
      }),
    ).toThrow();
  });

  test("rejected call is atomic: no objective.md/provenance.json left behind", () => {
    const id = newLoomId();
    expect(() =>
      quickBundle(id, {
        objective: "fix it",
        assertions: [{ id: "a1", description: "should be fixed", type: "value-equality", blocker: true }],
        provenance,
      }),
    ).toThrow();
    expect(readBundleFile(id, "objective.md")).toBeNull();
    expect(readBundleFile(id, PROVENANCE_FILE)).toBeNull();
    expect(readBundleFile(id, CONTRACT_FILE)).toBeNull();
  });

  test("rejects invalid provenance", () => {
    const id = newLoomId();
    expect(() =>
      quickBundle(id, {
        objective: "fix it",
        assertions: [{ id: "a1", description: "d", type: "contains", expected: "x", blocker: true }],
        provenance: { approvedBy: "", humanApprovedAt: Date.now() },
      }),
    ).toThrow();
    expect(readBundleFile(id, "objective.md")).toBeNull();
  });
});
