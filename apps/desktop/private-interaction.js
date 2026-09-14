/**
 * PRIVATE INTERACTION — the credential boundary for the integrated browser.
 *
 * The native browser is ONE Chromium partition shared by every session
 * scope, and a password manager's UI (its popup, its unlock, its fill) is
 * global to that partition. So privacy is global too: while a private
 * interaction is open, EVERY agent browser tool in EVERY scope is refused —
 * reads and mutations alike — and logs captured meanwhile are dropped. A
 * read that was in flight when privacy began is discarded on return.
 *
 * WHAT THIS IS NOT. It gates Telar's browser tools (the desktop manager's
 * `callTool`). It does not, and cannot, constrain an agent's shell or OS
 * tools; those are governed elsewhere and nothing here claims otherwise.
 *
 * THE EPOCH. Every begin/end bumps a counter. A tool call records the epoch
 * it started under and its result is thrown away if the epoch moved before
 * it returned — so a snapshot started a millisecond before the popup opened
 * cannot smuggle the page out.
 *
 * RELEASE IS AUTOMATIC. The desktop manager owns the lifecycle
 * (browser-manager.js): it opens the window on the 1Password popup / a
 * credential field, and ends it — bumping every tab's generation so the
 * agent's next mutation must re-observe — once the popup is closed AND a
 * focus-aware probe says no credential field is filled or focused. A person
 * only ever acts on the STUCK case (a page that will not answer the probe);
 * the normal flow needs no gesture.
 *
 * WHICH PAGE IS ASKED IS THE MANAGER'S RULE, and it is narrow (#480): only a
 * tab whose own preload REPORTED a credential field can hold the window open.
 * A tab nobody reported cannot be the reason the browser is paused — asking it
 * anyway is how one unrelated page with an unprobeable iframe once wedged every
 * agent's tools in every session with no way out but killing Telar. The stuck
 * case is now visible (a bar over the tab strip) and has a door: Resume
 * re-probes, and Resume anyway is the person overruling a page that will not
 * answer at all.
 *
 * This class stays the mechanism: begin, end, epoch, admit.
 */
class PrivateInteraction {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.onChange = options.onChange || null;
    this.epoch = 0;
    this.active = null; // { reason, startedAt, scopeKey } | null
  }

  isActive() {
    return this.active !== null;
  }

  /** Begin (or re-affirm) a private interaction. Idempotent for the same
   *  reason; a second begin extends rather than nests. */
  begin(reason, scopeKey) {
    if (this.active) {
      this.active.reason = reason || this.active.reason;
      return this.state();
    }
    this.epoch += 1;
    this.active = { reason: reason || "private", startedAt: this.now(), scopeKey: scopeKey || null };
    this.notify();
    return this.state();
  }

  /** End by an explicit human gesture. Bumps the epoch again so anything
   *  that started during privacy is discarded on return. */
  end() {
    if (!this.active) return this.state();
    this.epoch += 1;
    this.active = null;
    this.notify();
    return this.state();
  }

  state() {
    return { private: this.isActive(), epoch: this.epoch, ...(this.active ? { reason: this.active.reason, since: this.active.startedAt, scopeKey: this.active.scopeKey } : {}) };
  }

  notify() {
    if (!this.onChange) return;
    try {
      this.onChange(this.state());
    } catch {
      // A listener must never break the boundary it observes.
    }
  }

  /** The sentence a refused/discarded tool gets. Release is automatic, so this
   *  points at retrying, not at a human gesture. */
  refusal() {
    return "The browser is handling a sign-in (a person is entering credentials). Browser tools are paused and resume automatically when it finishes — retry in a moment.";
  }

  /** Wrap a tool result: refuse if private now, discard if privacy changed
   *  while the call ran. `epochAtStart` is what the caller recorded. */
  admit(result, epochAtStart) {
    if (this.isActive() || this.epoch !== epochAtStart) {
      return { content: [{ type: "text", text: `Error: ${this.refusal()}` }], isError: true, discarded: true };
    }
    return result;
  }
}

/** Targets an agent may never address: the extension's own pages. */
const EXTENSION_SCHEMES = ["chrome-extension:", "chrome:", "devtools:", "crx:"];

function isProtectedUrl(url) {
  try {
    const protocol = new URL(String(url || "")).protocol;
    return EXTENSION_SCHEMES.includes(protocol);
  } catch {
    return false;
  }
}

module.exports = { PrivateInteraction, isProtectedUrl, EXTENSION_SCHEMES };
