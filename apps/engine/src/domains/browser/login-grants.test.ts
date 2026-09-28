/**
 * The remembered-login store: what it will match, what it refuses to match,
 * and what it is allowed to contain.
 *
 * The matching tests are the point. A grant is four exact things — profile,
 * origin, item, field kinds — and every test below is one way of being wrong
 * about one of them.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { createLoginGrantStore, exactOrigin, LOGIN_GRANTS_FILE, LOGIN_GRANTS_VERSION } from "../src/secrets/login-grants";

const WORK = "bp_00000000000000a1";
const PERSONAL = "bp_00000000000000b2";

function store() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-grants-"));
  return { root, grants: createLoginGrantStore(root) };
}

function seed(grants: ReturnType<typeof createLoginGrantStore>, overrides: Record<string, unknown> = {}) {
  return grants.remember({
    profileId: WORK,
    profileLabel: "Work",
    origin: "https://github.com",
    itemId: "item_gh",
    itemTitle: "GitHub",
    vault: "Personal",
    fields: [{ kind: "username" }, { kind: "password" }],
    ...overrides,
  } as Parameters<typeof grants.remember>[0]);
}

test("a grant round-trips through the file, and the file is the only state", () => {
  const { root, grants } = store();
  const made = seed(grants);
  expect(createLoginGrantStore(root).list()).toEqual([made]);
  // 0600: the record is a pointer, not a secret, but it still names a person's
  // vault items and should not be world-readable.
  expect(fs.statSync(path.join(root, LOGIN_GRANTS_FILE)).mode & 0o077).toBe(0);
  expect(JSON.parse(fs.readFileSync(path.join(root, LOGIN_GRANTS_FILE), "utf8")).version).toBe(LOGIN_GRANTS_VERSION);
});

test("matching is exact on profile, origin and fields", () => {
  const { grants } = store();
  seed(grants);
  const wants = [{ kind: "username" as const }, { kind: "password" as const }];
  expect(grants.find({ profileId: WORK, origin: "https://github.com", wants })).not.toBeNull();
  // Another identity, another host of the same domain, a different scheme, a
  // path that is not an origin, an extra field: all misses.
  expect(grants.find({ profileId: PERSONAL, origin: "https://github.com", wants })).toBeNull();
  expect(grants.find({ profileId: WORK, origin: "https://gist.github.com", wants })).toBeNull();
  expect(grants.find({ profileId: WORK, origin: "http://github.com", wants })).toBeNull();
  expect(grants.find({ profileId: WORK, origin: "https://github.com/login", wants })).not.toBeNull(); // a URL still resolves to its origin
  expect(grants.find({ profileId: WORK, origin: "https://github.com", wants: [...wants, { kind: "otp" }] })).toBeNull();
  // An item id may be pinned, and a different one never matches.
  expect(grants.find({ profileId: WORK, origin: "https://github.com", itemId: "item_gh", wants })).not.toBeNull();
  expect(grants.find({ profileId: WORK, origin: "https://github.com", itemId: "item_other", wants })).toBeNull();
});

test("re-approving the same item replaces rather than accumulating", () => {
  const { grants } = store();
  seed(grants);
  const second = seed(grants, { fields: [{ kind: "username" }, { kind: "password" }, { kind: "otp" }] });
  expect(grants.list()).toEqual([second]);
});

test("revoking is immediate and idempotent", () => {
  const { grants } = store();
  const made = seed(grants);
  expect(grants.revoke(made.id)).toBe(true);
  expect(grants.revoke(made.id)).toBe(false);
  expect(grants.find({ profileId: WORK, origin: "https://github.com", wants: [{ kind: "password" }] })).toBeNull();
});

test("a grant that cannot name all four things is refused", () => {
  const { grants } = store();
  const base = { profileId: WORK, origin: "https://github.com", itemId: "item_gh", itemTitle: "GitHub", fields: [{ kind: "password" as const }] };
  expect(() => grants.remember({ ...base, origin: "chrome-extension://abc" })).toThrow(/exact http\(s\) origin/);
  expect(() => grants.remember({ ...base, profileId: "" })).toThrow(/browser profile/);
  expect(() => grants.remember({ ...base, itemId: "" })).toThrow(/item/);
  expect(() => grants.remember({ ...base, fields: [] })).toThrow(/fields/);
});

test("a hand-edited file authorizes nothing it cannot fully justify", () => {
  const { root, grants } = store();
  fs.writeFileSync(
    path.join(root, LOGIN_GRANTS_FILE),
    JSON.stringify({
      version: LOGIN_GRANTS_VERSION,
      grants: [
        // A `field` grant with no label would match ANY label: refused whole.
        { id: "a", profileId: WORK, origin: "https://github.com", itemId: "i", itemTitle: "t", fields: [{ kind: "field" }] },
        // No origin, no profile, no fields: each is a whole-record refusal.
        { id: "b", profileId: WORK, itemId: "i", itemTitle: "t", fields: [{ kind: "password" }] },
        { id: "c", origin: "https://github.com", itemId: "i", itemTitle: "t", fields: [{ kind: "password" }] },
        { id: "d", profileId: WORK, origin: "https://github.com", itemId: "i", itemTitle: "t", fields: [] },
        { id: "keep", profileId: WORK, origin: "https://github.com", itemId: "i", itemTitle: "t", fields: [{ kind: "password" }], createdAt: 1 },
      ],
    }),
  );
  expect(grants.list().map((grant) => grant.id)).toEqual(["keep"]);
  // An unreadable file is not an open door either.
  fs.writeFileSync(path.join(root, LOGIN_GRANTS_FILE), "{not json");
  expect(grants.list()).toEqual([]);
  expect(grants.find({ profileId: WORK, origin: "https://github.com", wants: [{ kind: "password" }] })).toBeNull();
});

test("findAll returns every authorized item; find refuses to pick between them", () => {
  const { grants } = store();
  seed(grants);
  seed(grants, { itemId: "item_work", itemTitle: "GitHub (work)" });
  const wants = [{ kind: "username" as const }, { kind: "password" as const }];
  expect(grants.findAll({ profileId: WORK, origin: "https://github.com", wants }).map((grant) => grant.itemId).sort()).toEqual([
    "item_gh",
    "item_work",
  ]);
  // Two authorized accounts and nothing naming one: NOT an answer.
  expect(grants.find({ profileId: WORK, origin: "https://github.com", wants })).toBeNull();
  // Naming one is.
  expect(grants.find({ profileId: WORK, origin: "https://github.com", itemId: "item_work", wants })!.itemTitle).toBe("GitHub (work)");
});

// ── CONCURRENCY: two processes, one file ──────────────────────────────────

/**
 * The daemon (a person revoking in settings) and a worker (a fill remembering
 * or touching) mutate this file at the same time, in DIFFERENT PROCESSES. An
 * atomic rename makes each write indivisible and does nothing about a
 * read-modify-write interleaving, so these run real `bun` subprocesses against
 * one directory rather than simulating it in this one.
 */
test("concurrent processes never lose a write: 6 × 20 remembers all land", async () => {
  const { root } = store();
  const script = `
    const { createLoginGrantStore } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../src/secrets/login-grants.ts"))});
    const grants = createLoginGrantStore(process.env.TELAR_GRANT_ROOT);
    const worker = process.argv[process.argv.length - 1];
    for (let i = 0; i < 20; i += 1) {
      grants.remember({
        profileId: "bp_00000000000000a1",
        origin: "https://github.com",
        itemId: "item_" + worker + "_" + i,
        itemTitle: "item " + worker + " " + i,
        fields: [{ kind: "password" }],
      });
    }
  `;
  const children = Array.from({ length: 6 }, (_, index) =>
    Bun.spawn(["bun", "-e", script, String(index)], {
      env: { ...process.env, TELAR_GRANT_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const codes = await Promise.all(children.map((child) => child.exited));
  const errors = await Promise.all(children.map((child) => new Response(child.stderr).text()));
  expect({ codes, errors: errors.filter(Boolean) }).toEqual({ codes: [0, 0, 0, 0, 0, 0], errors: [] });

  // Every one of the 120 is on disk. Without the lock this reliably loses
  // most of them: each process reads a list, appends one, writes it back.
  const landed = createLoginGrantStore(root).list();
  expect(landed).toHaveLength(120);
  expect(new Set(landed.map((grant) => grant.itemId)).size).toBe(120);
}, 30_000);

test("a revoke is not resurrected by a concurrent touch", async () => {
  const { root, grants } = store();
  const doomed = seed(grants);
  const survivor = seed(grants, { itemId: "item_work", itemTitle: "GitHub (work)" });
  const script = `
    const { createLoginGrantStore } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../src/secrets/login-grants.ts"))});
    const grants = createLoginGrantStore(process.env.TELAR_GRANT_ROOT);
    const id = process.argv[process.argv.length - 1];
    for (let i = 0; i < 200; i += 1) grants.touch(id);
  `;
  // A worker touching the doomed grant in a tight loop while this process
  // revokes it. `touch` re-reads inside the lock, so once the revoke lands the
  // touches find nothing and write nothing back.
  const toucher = Bun.spawn(["bun", "-e", script, doomed.id], { env: { ...process.env, TELAR_GRANT_ROOT: root }, stdout: "pipe", stderr: "pipe" });
  await Bun.sleep(60);
  expect(grants.revoke(doomed.id)).toBe(true);
  expect(await toucher.exited).toBe(0);

  const after = createLoginGrantStore(root).list();
  expect(after.map((grant) => grant.id)).toEqual([survivor.id]);
}, 30_000);

test("exactOrigin keeps http(s) origins and nothing else", () => {
  expect(exactOrigin("https://github.com/login?x=1")).toBe("https://github.com");
  expect(exactOrigin("http://localhost:3000")).toBe("http://localhost:3000");
  expect(exactOrigin("file:///etc/passwd")).toBeNull();
  expect(exactOrigin("not a url")).toBeNull();
});
