/**
 * The login offer's controller — everything between "an entry finished"
 * (browser-manager.js) and "a grant was written" (login-grant-writer.js),
 * with no Electron in it so every path is testable with fakes.
 *
 * Trust model: the scope comes from main-held state — the window can only
 * confirm the capture this controller holds, re-checked at write time
 * (`confirmationMatches`) because the world moves while a window is open.
 * The item comes from the person, off a list this controller fetched; an ID
 * nobody was shown matches nothing, and window-supplied titles are never
 * trusted. No page event is a confirmation: the only writer is `confirm`,
 * reached from the trusted window after a click — `entryFinished` and
 * `explicitOffer` only ever open the question, so an agent causing the
 * question to appear grants nothing.
 */
"use strict";
const { shouldOffer, offerKey, grantFromCapture, confirmationMatches } = require("./login-offer");

/**
 * `deps`:
 *   listCandidates(origin) → Promise<{ok,candidates}|{ok:false,error}>
 *   rememberGrant(grant)   → persists a confirmed grant (throws on refusal)
 *   ui.open() / ui.close() / ui.refresh() — the window, whatever renders it
 *   now() — the clock
 */
function createLoginOfferFlow({ listCandidates, rememberGrant, ui, now = Date.now }) {
  /** The latest FINISHED entry main knows about — the held state confirms
   *  against. Replaced by newer entries, never by the window. */
  let current = null;
  /** The capture the open window is asking about, snapshotted at open. */
  let offered = null;
  /** id → candidate, exactly the list fetched for `offered` — the only items
   *  a confirm can name. */
  let listed = new Map();
  /** offerKey()s the person dismissed or acted on, per run. */
  const dismissed = new Set();
  /** A grant write in flight — further confirms refuse instead of racing it. */
  let confirming = false;

  const clearOffer = () => {
    offered = null;
    listed = new Map();
  };

  return {
    /** An entry finished (browser-manager's automatic release). Decides
     *  whether the AUTOMATIC offer appears; a dismissal or the TTL keeps it
     *  quiet, an existing grant deliberately does not (second account). */
    entryFinished(capture) {
      if (!capture) return;
      current = capture;
      if (!shouldOffer(capture, { dismissed, now: now() })) return;
      const alreadyOpen = offered !== null;
      offered = capture;
      listed = new Map();
      if (alreadyOpen) ui.refresh();
      else ui.open();
    },

    /** The EXPLICIT affordance — a person asking for the offer about the page
     *  they are on. Never suppressed: not by a dismissal, not by anything. */
    explicitOffer(capture) {
      if (!capture) return { ok: false, error: "There is no page to remember a login for." };
      const alreadyOpen = offered !== null;
      current = capture;
      offered = capture;
      listed = new Map();
      if (alreadyOpen) ui.refresh();
      else ui.open();
      return { ok: true };
    },

    /** What the window renders: the captured address and identity, and the
     *  domain-matched item METADATA the person picks from. */
    async state() {
      // Snapshot the offer this read is FOR. The listing is async and the
      // offer is mutable: it can be dismissed or replaced by another site's
      // entry while the vault is answering, and a stale answer must neither
      // render under the new offer nor become its confirmable item list.
      const target = offered;
      if (!target) return { error: "Nothing to offer — the moment has passed." };
      let result;
      try {
        result = await listCandidates(target.origin);
      } catch (error) {
        result = { ok: false, error: error && error.message ? error.message : "1Password could not be asked." };
      }
      if (offered !== target) return { error: "Nothing to offer — the moment has passed." };
      if (!result.ok) return { origin: target.origin, profileLabel: target.profileLabel, candidates: [], error: result.error };
      listed = new Map(result.candidates.map((candidate) => [candidate.id, candidate]));
      return { origin: target.origin, profileLabel: target.profileLabel, candidates: result.candidates };
    },

    /**
     * The human clicked Allow in the trusted window. Everything is re-checked
     * HERE, against what main holds NOW: the offered capture must still be the
     * current one (same tab, same origin, same profile, within the TTL), and
     * the item must be one this controller listed. Only then is the grant —
     * built from the CAPTURE and the person's item, nothing from the caller —
     * written.
     */
    async confirm(input) {
      // One confirmation at a time: the write below is async, and a second
      // click (or a replayed IPC) racing the first must not write again.
      if (confirming) return { ok: false, error: "A confirmation is already being saved." };
      const target = offered;
      if (!target) return { ok: false, error: "Nothing to confirm — the offer is no longer open." };
      if (!confirmationMatches(target, current, { now: now() })) {
        clearOffer();
        dismissed.add(offerKey(target));
        ui.close();
        return { ok: false, error: "The page or sign-in this offer was about has changed, so nothing was remembered." };
      }
      const item = listed.get(input && input.itemId);
      if (!item) return { ok: false, error: "Pick one of the listed 1Password items." };
      const fields = ["username", "password", ...(input.otp ? ["otp"] : [])];
      const grant = grantFromCapture(target, { itemId: item.id, itemTitle: item.title, vault: item.vault }, { fields });
      if (!grant) return { ok: false, error: "This offer cannot become an authorization." };
      confirming = true;
      try {
        await rememberGrant(grant);
      } catch (error) {
        return { ok: false, error: error && error.message ? error.message : "The authorization could not be saved." };
      } finally {
        confirming = false;
      }
      dismissed.add(offerKey(target));
      // A different offer may have replaced this one during the write; only
      // the offer that was confirmed is cleared and closed.
      if (offered === target) {
        clearOffer();
        ui.close();
      }
      return { ok: true, itemTitle: item.title, origin: grant.origin };
    },

    /** "Not now" — and closing the window is the same answer. One automatic
     *  offer per identity+address per run; the explicit affordance remains. */
    dismiss() {
      if (offered) dismissed.add(offerKey(offered));
      clearOffer();
      ui.close();
      return { ok: true };
    },

    /** The window went away without a verdict (closed by the person, or the
     *  app). Counts as a dismissal for the automatic offer this run. */
    windowClosed() {
      if (offered) dismissed.add(offerKey(offered));
      clearOffer();
    },
  };
}

/**
 * IS THIS IPC EVENT THE TRUSTED OFFER WINDOW SPEAKING? — the sender must be
 * the window's own WebContents AND its TOP frame. A subframe (there should be
 * none, but the check does not rely on that), a browser tab's preload, or the
 * cockpit renderer invoking the offer channels is refused. Kept here, pure,
 * so the rule itself is unit-tested.
 */
function isTrustedOfferSender(event, window) {
  if (!window || (typeof window.isDestroyed === "function" && window.isDestroyed())) return false;
  const contents = window.webContents;
  if (!contents || !event) return false;
  return event.sender === contents && event.senderFrame === contents.mainFrame;
}

module.exports = { createLoginOfferFlow, isTrustedOfferSender };
