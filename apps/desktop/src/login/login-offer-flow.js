"use strict";
const { shouldOffer, offerKey, grantFromCapture, confirmationMatches } = require("./login-offer");

function createLoginOfferFlow({ listCandidates, rememberGrant, ui, now = Date.now, autoOffer = () => false }) {
  let current = null;

  let offered = null;

  let listed = new Map();

  const dismissed = new Set();

  let confirming = false;

  const clearOffer = () => {
    offered = null;
    listed = new Map();
  };

  return {
    entryFinished(capture) {
      if (!capture) return;
      current = capture;
      if (!autoOffer()) return;
      if (!shouldOffer(capture, { dismissed, now: now() })) return;
      const alreadyOpen = offered !== null;
      offered = capture;
      listed = new Map();
      if (alreadyOpen) ui.refresh();
      else ui.open();
    },

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

    async state() {
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

    async confirm(input) {
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

      if (offered === target) {
        clearOffer();
        ui.close();
      }
      return { ok: true, itemTitle: item.title, origin: grant.origin };
    },

    dismiss() {
      if (offered) dismissed.add(offerKey(offered));
      clearOffer();
      ui.close();
      return { ok: true };
    },

    windowClosed() {
      if (offered) dismissed.add(offerKey(offered));
      clearOffer();
    },
  };
}

function isTrustedOfferSender(event, window) {
  if (!window || (typeof window.isDestroyed === "function" && window.isDestroyed())) return false;
  const contents = window.webContents;
  if (!contents || !event) return false;
  return event.sender === contents && event.senderFrame === contents.mainFrame;
}

module.exports = { createLoginOfferFlow, isTrustedOfferSender };
