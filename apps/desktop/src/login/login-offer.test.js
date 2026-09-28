// AUTH-001 (#195). Metadata only: no test here holds a credential, and the
// module under test has no way to read one.
const { describe, expect, test } = require("bun:test");
const {
  captureEntry,
  confirmationMatches,
  grantFromCapture,
  offerKey,
  shouldOffer,
  OFFER_TTL_MS,
} = require("./login-offer");

const entry = (over = {}) => ({
  kind: "input",
  origin: "https://accounts.example.com/signin?next=/inbox",
  profileId: "profile_1",
  profileLabel: "Personal",
  tabUid: "tab_7",
  at: 1000,
  ...over,
});

describe("what counts as a credential entry", () => {
  test("focus alone is never an entry", () => {
    // Tabbing through a form, or a page autofocusing its username box, must
    // not produce an offer.
    expect(captureEntry(entry({ kind: "focus" }))).toBeNull();
  });

  test("typed and filled are the same thing here — a value was entered", () => {
    // `fill` means the value arrived without a trusted input event, which is
    // what a password manager looks like AND what a page's own script looks
    // like. Neither names its source, and nothing here claims 1Password.
    expect(captureEntry(entry({ kind: "input" })?.kind ? entry({ kind: "input" }) : null)).not.toBeNull();
    expect(captureEntry(entry({ kind: "fill" }))).not.toBeNull();
  });

  test("the origin is reduced to an exact origin, losing the path", () => {
    // A grant names an address, not a page: the query string above carries a
    // `next=` that must never become part of what was authorised.
    expect(captureEntry(entry())?.origin).toBe("https://accounts.example.com");
  });

  test("a non-web scheme is refused", () => {
    for (const origin of ["file:///tmp/x.html", "chrome://settings", "not a url", ""]) {
      expect(captureEntry(entry({ origin }))).toBeNull();
    }
  });

  test("an entry with no identity is refused", () => {
    expect(captureEntry(entry({ profileId: "" }))).toBeNull();
    expect(captureEntry(entry({ tabUid: "" }))).toBeNull();
  });
});

describe("when the automatic offer appears", () => {
  test("not after the moment has passed", () => {
    const capture = captureEntry(entry());
    expect(shouldOffer(capture, { now: 1000 + OFFER_TTL_MS + 1 })).toBe(false);
    expect(shouldOffer(capture, { now: 1000 + 1000 })).toBe(true);
  });

  test("not once the person has waved it away", () => {
    const capture = captureEntry(entry());
    expect(shouldOffer(capture, { dismissed: new Set([offerKey(capture)]), now: 1200 })).toBe(false);
  });

  test("a second account on the same origin still offers", () => {
    // The case the feature exists for: an existing grant is not a reason to
    // stay quiet, because this may be a different account.
    const first = captureEntry(entry({ tabUid: "tab_7" }));
    const second = captureEntry(entry({ tabUid: "tab_9", at: 2000 }));
    expect(offerKey(first)).toBe(offerKey(second));
    expect(shouldOffer(second, { now: 2100 })).toBe(true);
  });
});

describe("the grant a confirmation may create", () => {
  test("scope comes from the CAPTURE, never from the caller", () => {
    // A request that named its own origin could widen a grant to an address
    // nobody signed into. There is no parameter for it.
    const grant = grantFromCapture(captureEntry(entry()), { itemId: "item_a", itemTitle: "Example — work" });
    expect(grant).toMatchObject({
      profileId: "profile_1",
      origin: "https://accounts.example.com",
      itemId: "item_a",
      itemTitle: "Example — work",
    });
  });

  test("the item is required and never inferred", () => {
    expect(grantFromCapture(captureEntry(entry()), null)).toBeNull();
    expect(grantFromCapture(captureEntry(entry()), { itemId: "" })).toBeNull();
  });

  test("otp is a grantable permission — retrieving a fresh code, not storing one", () => {
    // Least scope means exactly the kinds the person saw named; a fill asking
    // for more does not match (login-grants.ts). It does NOT mean otp is
    // forbidden: the vault generates the code at fill time.
    const grant = grantFromCapture(captureEntry(entry()), { itemId: "i" }, { fields: ["password", "otp"] });
    expect(grant?.fields).toEqual([{ kind: "password" }, { kind: "otp" }]);
  });

  test("an unknown field kind is refused", () => {
    expect(grantFromCapture(captureEntry(entry()), { itemId: "i" }, { fields: ["cookie"] })).toBeNull();
  });

  test("the default is the least that signs a person in", () => {
    expect(grantFromCapture(captureEntry(entry()), { itemId: "i" })?.fields).toEqual([
      { kind: "username" },
      { kind: "password" },
    ]);
  });

  test("two accounts on one origin are two distinct grants", () => {
    const capture = captureEntry(entry());
    const work = grantFromCapture(capture, { itemId: "item_work", itemTitle: "work" });
    const home = grantFromCapture(capture, { itemId: "item_home", itemTitle: "home" });
    expect(work?.itemId).not.toBe(home?.itemId);
    expect(work?.origin).toBe(home?.origin);
  });
});

describe("what the trusted window is allowed to confirm", () => {
  test("a confirmation for another tab is refused", () => {
    const held = captureEntry(entry());
    expect(confirmationMatches(captureEntry(entry({ tabUid: "tab_other" })), held, { now: 1100 })).toBe(false);
  });

  test("a confirmation for another origin is refused", () => {
    // A redirect during sign-in must not broaden what gets written.
    const held = captureEntry(entry());
    const moved = captureEntry(entry({ origin: "https://mail.example.com/u/0" }));
    expect(confirmationMatches(moved, held, { now: 1100 })).toBe(false);
  });

  test("a confirmation that arrives too late is refused", () => {
    const held = captureEntry(entry());
    expect(confirmationMatches(held, held, { now: 1000 + OFFER_TTL_MS + 1 })).toBe(false);
    expect(confirmationMatches(held, held, { now: 1100 })).toBe(true);
  });
});
