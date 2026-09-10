/**
 * "ALLOW A LOGIN FOR AGENTS" — the offer a person may get after signing in by
 * hand, and the rules about when it is allowed to appear.
 *
 * WHY THIS EXISTS. Telar can already remember a login: the approval card for
 * `browser_fill_secret` carries an unchecked opt-in. But that card only ever
 * appears when an AGENT asks to fill a credential. A person who signs in
 * themselves — typing, or accepting their password manager's inline suggestion
 * — never passes through it, so the one moment they are most likely to think
 * "yes, the agent may do this next time" is the moment Telar said nothing.
 *
 * WHAT IS AND IS NOT KNOWN, stated plainly because the wording depends on it:
 *
 *   - A VALUE WAS ENTERED IN A CREDENTIAL FIELD. That is all the page reports
 *     (browser-tab-preload.js sends the FACT, never a value). `kind: "fill"`
 *     means the value arrived without a trusted input event — which is what a
 *     password manager's autofill looks like, AND ALSO what a page's own script
 *     looks like. It is not proof of 1Password and this module never says it is.
 *   - THE ENTRY FINISHED. `autoRelease` runs when a focus-aware probe says no
 *     credential field is filled or focused any more. That is the end of typing.
 *     IT IS NOT PROOF THE SIGN-IN SUCCEEDED — the password may have been wrong,
 *     the form may never have been submitted — so nothing here claims a
 *     successful login, and the offer is phrased as a permission question.
 *   - FOCUS ALONE IS NOT ENTRY. A person tabbing through a form, or a page
 *     autofocusing its username box, must not produce an offer.
 *   - WHICH VAULT ITEM WAS USED IS UNKNOWABLE. The extension does not tell the
 *     host what it filled, and reading the page to guess would be reading a
 *     credential. The person picks the item, always, from domain-matched
 *     metadata. There is no implicit selection anywhere in this feature.
 *
 * THE CAPTURE IS IMMUTABLE, and that is the security property. A sign-in
 * redirects — `accounts.google.com` becomes `mail.google.com`, an SPA rewrites
 * its own URL without navigating at all — so the origin, profile and tab are
 * recorded WHEN THE VALUE IS ENTERED and never rewritten afterwards. A grant
 * therefore names the page the person typed into, and no redirect can broaden
 * it to wherever the browser ended up.
 *
 * WHICH IS ALSO WHY A LATER NAVIGATION IS NOT REQUIRED. An SPA login produces
 * none, and a cross-domain one produces the wrong one. The trigger is simply
 * "an entry happened and finished".
 */

/** How long a captured entry stays offerable. A person who typed a password an
 *  hour ago is not in the moment this is about. */
const OFFER_TTL_MS = 5 * 60 * 1000;

/**
 * A credential entry worth offering about, or null.
 *
 * `kind` is the page's report: `focus` (never an entry), `input` (typed), or
 * `fill` (a value appeared without a trusted input event). The last two are the
 * same thing here — a value was entered — and neither names its source.
 */
function captureEntry({ kind, origin, profileId, profileLabel, tabUid, at }) {
  if (kind !== "input" && kind !== "fill") return null;
  if (!origin || !profileId || !tabUid) return null;
  let exact;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    exact = url.origin;
  } catch {
    return null;
  }
  return { origin: exact, profileId, ...(profileLabel ? { profileLabel } : {}), tabUid, at };
}

/**
 * Should the AUTOMATIC offer appear for this capture?
 *
 * `dismissed` is the set of `profileId\norigin` keys a person has already waved
 * away (or acted on) in this run. `now` is the clock.
 *
 * AN EXISTING GRANT DOES NOT SUPPRESS THIS. A person with two Google accounts
 * signs into the second one on the same origin in the same profile, and that is
 * exactly the case where a second authorization is wanted — so "we already have
 * one for this origin" is not a reason to stay quiet. Only the person's own
 * dismissal is. (And the explicit affordance below is never suppressed at all.)
 */
function shouldOffer(capture, { dismissed = new Set(), now = Date.now() } = {}) {
  if (!capture) return false;
  if (now - capture.at > OFFER_TTL_MS) return false;
  return !dismissed.has(offerKey(capture));
}

/** One automatic offer per identity+address per run, until the person acts. */
function offerKey({ profileId, origin }) {
  return `${profileId}\n${origin}`;
}

module.exports = { captureEntry, shouldOffer, offerKey, OFFER_TTL_MS };
