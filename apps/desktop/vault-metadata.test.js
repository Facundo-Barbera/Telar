// The listing the offer shows must be the listing a later fill computes, so
// the domain heuristic is pinned against the ENGINE'S OWN implementation.
// Every exec here is a fake returning fixture metadata — no `op`, no vault.
const { describe, expect, test } = require("bun:test");
const { listLoginCandidates, registrableDomain, OP_NOT_INSTALLED, OP_LOCKED } = require("./vault-metadata");
const engine = require("../engine/src/secrets/onepassword.ts");

describe("registrableDomain mirrors the engine", () => {
  test("agreement across the shapes that matter", () => {
    for (const host of [
      "login.github.com", "github.com", "deep.sub.example.co.uk", "example.co.uk", "co.uk",
      "localhost", "127.0.0.1", "10.0.0.1", "example.com.", "single", "a.b.co.jp", "x.com.au",
      "", "weird..host", "[::1]",
    ]) {
      expect(registrableDomain(host)).toBe(engine.registrableDomain(host));
    }
  });
});

const item = (over = {}) => ({
  id: "item_a",
  title: "Example — work",
  vault: { name: "Private" },
  urls: [{ href: "https://accounts.example.com/signin" }],
  ...over,
});

const execReturning = (items) => async () => ({ code: 0, stdout: JSON.stringify(items) });

describe("listLoginCandidates", () => {
  test("lists items whose website matches the page's registrable domain", async () => {
    const result = await listLoginCandidates(
      "https://mail.example.com",
      execReturning([
        item(),
        item({ id: "item_other", title: "Elsewhere", urls: [{ href: "https://other.net" }] }),
        item({ id: null, title: "no id" }),
      ]),
    );
    expect(result).toEqual({
      ok: true,
      candidates: [{ id: "item_a", title: "Example — work", domain: "example.com", vault: "Private" }],
    });
  });

  test("a page with no registrable domain is refused before op runs", async () => {
    let ran = false;
    const result = await listLoginCandidates("http://localhost:3000", async () => {
      ran = true;
      return { code: 0, stdout: "[]" };
    });
    expect(result.ok).toBe(false);
    expect(ran).toBe(false);
  });

  test("op missing, op locked, op talking nonsense", async () => {
    const enoent = Object.assign(new Error("spawn op ENOENT"), { code: "ENOENT" });
    expect((await listLoginCandidates("https://example.com", async () => { throw enoent; })).error).toBe(OP_NOT_INSTALLED);
    expect((await listLoginCandidates("https://example.com", async () => ({ code: 1, stdout: "" }))).error).toBe(OP_LOCKED);
    expect((await listLoginCandidates("https://example.com", async () => ({ code: 0, stdout: "not json" }))).ok).toBe(false);
    expect((await listLoginCandidates("https://example.com", async () => ({ code: 0, stdout: "{}" }))).ok).toBe(false);
  });

  test("the one op invocation is the metadata listing, never an item read", async () => {
    let seen = null;
    await listLoginCandidates("https://example.com", async (args) => {
      seen = args;
      return { code: 0, stdout: "[]" };
    });
    expect(seen).toEqual(["item", "list", "--categories", "Login", "--format", "json"]);
  });
});
