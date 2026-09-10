// AUTH-001 (#195): the controller between "an entry finished" and "a grant was
// written". Every dependency is a fake; every assertion is about metadata —
// nothing in this file, or in the module under test, can hold a credential.
const { describe, expect, test } = require("bun:test");
const { createLoginOfferFlow, isTrustedOfferSender } = require("./login-offer-flow");
const { captureEntry, OFFER_TTL_MS } = require("./login-offer");

const capture = (over = {}) =>
  captureEntry({
    kind: "input",
    origin: "https://accounts.example.com/signin",
    profileId: "profile_1",
    profileLabel: "Personal",
    tabUid: "tab_7",
    at: 1000,
    ...over,
  });

function harness(over = {}) {
  const ui = { open: 0, close: 0, refresh: 0 };
  const written = [];
  const state = {
    now: 1500,
    candidates: { ok: true, candidates: [{ id: "item_a", title: "Example — work", domain: "example.com", vault: "Private" }] },
  };
  const flow = createLoginOfferFlow({
    listCandidates: async () => state.candidates,
    rememberGrant: (grant) => written.push(grant),
    ui: { open: () => (ui.open += 1), close: () => (ui.close += 1), refresh: () => (ui.refresh += 1) },
    now: () => state.now,
    ...over,
  });
  return { flow, ui, written, state };
}

describe("when the offer window opens", () => {
  test("a finished entry opens it, and the window reads the capture's address and identity", async () => {
    const { flow, ui } = harness();
    flow.entryFinished(capture());
    expect(ui.open).toBe(1);
    const shown = await flow.state();
    expect(shown.origin).toBe("https://accounts.example.com");
    expect(shown.profileLabel).toBe("Personal");
    expect(shown.candidates.map((candidate) => candidate.id)).toEqual(["item_a"]);
  });

  test("a dismissal silences the AUTOMATIC offer for that identity+address this run", () => {
    const { flow, ui } = harness();
    flow.entryFinished(capture());
    flow.dismiss();
    flow.entryFinished(capture({ at: 2000, tabUid: "tab_9" })); // second account, same address
    expect(ui.open).toBe(1);
  });

  test("the EXPLICIT offer is never suppressed — not by a dismissal", () => {
    const { flow, ui } = harness();
    flow.entryFinished(capture());
    flow.dismiss();
    expect(flow.explicitOffer(capture({ at: 2000 }))).toEqual({ ok: true });
    expect(ui.open).toBe(2);
  });

  test("closing the window without a verdict is a dismissal", () => {
    const { flow, ui } = harness();
    flow.entryFinished(capture());
    flow.windowClosed();
    flow.entryFinished(capture({ at: 2000 }));
    expect(ui.open).toBe(1);
  });

  test("a stale capture never offers", () => {
    const { flow, ui, state } = harness();
    state.now = 1000 + OFFER_TTL_MS + 1;
    flow.entryFinished(capture());
    expect(ui.open).toBe(0);
  });
});

describe("what a confirmation writes", () => {
  test("the grant is the CAPTURE plus the person's item — nothing from the caller", async () => {
    const { flow, written, ui } = harness();
    flow.entryFinished(capture());
    await flow.state();
    const result = await flow.confirm({ itemId: "item_a" });
    expect(result.ok).toBe(true);
    expect(written).toEqual([
      {
        profileId: "profile_1",
        profileLabel: "Personal",
        origin: "https://accounts.example.com",
        itemId: "item_a",
        itemTitle: "Example — work",
        vault: "Private",
        fields: [{ kind: "username" }, { kind: "password" }],
      },
    ]);
    expect(ui.close).toBe(1);
  });

  test("otp is added only when the person ticked it — a fresh-code permission, not a stored secret", async () => {
    const { flow, written } = harness();
    flow.entryFinished(capture());
    await flow.state();
    await flow.confirm({ itemId: "item_a", otp: true });
    expect(written[0].fields).toEqual([{ kind: "username" }, { kind: "password" }, { kind: "otp" }]);
  });

  test("an item nobody was shown matches nothing", async () => {
    const { flow, written } = harness();
    flow.entryFinished(capture());
    await flow.state();
    const result = await flow.confirm({ itemId: "item_the_window_invented" });
    expect(result.ok).toBe(false);
    expect(written).toEqual([]);
  });

  test("after the person acts, the same address does not automatically re-offer this run", async () => {
    const { flow, ui } = harness();
    flow.entryFinished(capture());
    await flow.state();
    await flow.confirm({ itemId: "item_a" });
    flow.entryFinished(capture({ at: 2000, tabUid: "tab_9" }));
    expect(ui.open).toBe(1);
  });

  test("a confirmation for a world that moved is refused — a newer entry replaced the held state", async () => {
    const { flow, written, ui } = harness();
    // The person dismissed site B earlier this run…
    flow.entryFinished(capture({ origin: "https://other.example.net/x", tabUid: "tab_2" }));
    flow.dismiss();
    // …the offer opens for site A…
    flow.entryFinished(capture({ at: 1400 }));
    await flow.state();
    // …then an entry on B finishes while the window is open (suppressed as an
    // offer, but it IS the capture main now holds).
    flow.entryFinished(capture({ origin: "https://other.example.net/x", tabUid: "tab_2", at: 1450 }));
    const closesBefore = ui.close; // the earlier dismiss() closed once already
    const result = await flow.confirm({ itemId: "item_a" });
    expect(result.ok).toBe(false);
    expect(written).toEqual([]);
    expect(ui.close).toBe(closesBefore + 1); // the refusal also closes the window
  });

  test("a confirmation that arrives too late is refused", async () => {
    const { flow, written, state } = harness();
    flow.entryFinished(capture());
    await flow.state();
    state.now = 1000 + OFFER_TTL_MS + 1;
    expect((await flow.confirm({ itemId: "item_a" })).ok).toBe(false);
    expect(written).toEqual([]);
  });

  test("a second confirm has nothing left to confirm", async () => {
    const { flow, written } = harness();
    flow.entryFinished(capture());
    await flow.state();
    await flow.confirm({ itemId: "item_a" });
    expect((await flow.confirm({ itemId: "item_a" })).ok).toBe(false);
    expect(written.length).toBe(1);
  });

  test("a writer refusal surfaces as the answer, not a crash", async () => {
    const { flow } = harness({
      rememberGrant: () => {
        throw new Error("Could not take the browser login grant lock.");
      },
    });
    flow.entryFinished(capture());
    await flow.state();
    const result = await flow.confirm({ itemId: "item_a" });
    expect(result).toEqual({ ok: false, error: "Could not take the browser login grant lock." });
  });

  test("a vault that cannot answer leaves nothing confirmable", async () => {
    const { flow, written, state } = harness();
    state.candidates = { ok: false, error: "1Password is locked." };
    flow.entryFinished(capture());
    const shown = await flow.state();
    expect(shown.error).toBe("1Password is locked.");
    expect((await flow.confirm({ itemId: "item_a" })).ok).toBe(false);
    expect(written).toEqual([]);
  });
});

describe("the offer moving while the vault answers", () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
  };

  test("metadata fetched for offer A never becomes offer B's confirmable list", async () => {
    const gate = deferred();
    const { flow, written } = harness({ listCandidates: () => gate.promise });
    flow.entryFinished(capture()); // offer A opens; its listing is in flight
    const pending = flow.state();
    // B replaces A while the vault is still answering for A.
    flow.entryFinished(capture({ origin: "https://other.example.net/x", tabUid: "tab_2", at: 1400 }));
    gate.resolve({ ok: true, candidates: [{ id: "item_a", title: "Example — work", domain: "example.com", vault: "Private" }] });
    const stale = await pending;
    expect(stale.error).toBeTruthy();
    expect(stale.candidates).toBeUndefined();
    // A's item cannot be confirmed under B's scope: it was never listed for B.
    const result = await flow.confirm({ itemId: "item_a" });
    expect(result.ok).toBe(false);
    expect(written).toEqual([]);
  });

  test("a dismissal while the listing is in flight is an empty answer, not a crash", async () => {
    const gate = deferred();
    const { flow } = harness({ listCandidates: () => gate.promise });
    flow.entryFinished(capture());
    const pending = flow.state();
    flow.dismiss();
    gate.resolve({ ok: false, error: "1Password is locked." });
    expect((await pending).error).toBeTruthy();
  });

  test("two confirms racing one slow write produce exactly one grant", async () => {
    const gate = deferred();
    const written = [];
    const { flow } = harness({
      rememberGrant: async (grant) => {
        await gate.promise;
        written.push(grant);
      },
    });
    flow.entryFinished(capture());
    await flow.state();
    const first = flow.confirm({ itemId: "item_a" });
    const second = await flow.confirm({ itemId: "item_a" }); // the double-click
    expect(second).toEqual({ ok: false, error: "A confirmation is already being saved." });
    gate.resolve();
    expect((await first).ok).toBe(true);
    expect(written.length).toBe(1);
  });

  test("an offer that replaced the confirmed one mid-write survives the confirmation", async () => {
    const gate = deferred();
    const { flow, ui } = harness({ rememberGrant: async () => { await gate.promise; } });
    flow.entryFinished(capture());
    await flow.state();
    const pending = flow.confirm({ itemId: "item_a" });
    // A new sign-in elsewhere opens offer B while A's grant is being saved.
    flow.entryFinished(capture({ origin: "https://other.example.net/x", tabUid: "tab_2", at: 1450 }));
    gate.resolve();
    expect((await pending).ok).toBe(true);
    // B's offer was not torn down by A's completion…
    expect(ui.close).toBe(0);
    // …and the window now asks about B.
    expect((await flow.state()).origin).toBe("https://other.example.net");
  });
});

describe("who may speak on the offer channels", () => {
  const makeWindow = () => {
    const mainFrame = {};
    const webContents = { mainFrame };
    return { window: { isDestroyed: () => false, webContents }, webContents, mainFrame };
  };

  test("only the trusted window's own top frame", () => {
    const { window, webContents, mainFrame } = makeWindow();
    expect(isTrustedOfferSender({ sender: webContents, senderFrame: mainFrame }, window)).toBe(true);
    // Another renderer — a browser tab, the cockpit — is refused.
    expect(isTrustedOfferSender({ sender: {}, senderFrame: mainFrame }, window)).toBe(false);
    // A subframe of the right WebContents is refused.
    expect(isTrustedOfferSender({ sender: webContents, senderFrame: {} }, window)).toBe(false);
    // No window, or a destroyed one, trusts nobody.
    expect(isTrustedOfferSender({ sender: webContents, senderFrame: mainFrame }, null)).toBe(false);
    expect(isTrustedOfferSender({ sender: webContents, senderFrame: mainFrame }, { isDestroyed: () => true, webContents })).toBe(false);
  });
});
