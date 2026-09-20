/**
 * WHICH CHORDS ARE SPOKEN FOR, ACROSS TWO OWNERS THAT CAN BOTH BE LIVE (#660).
 *
 * #656 gave the cockpit renderer a claim stack (`claimChords`) and mirrored it
 * into the shell as one list. That was enough while the renderer was the only
 * claimant: a palette is up or it is not, and a palette always has DOM focus.
 *
 * The browser panel broke that assumption. Its load-bearing state is focus
 * INSIDE a `WebContentsView`, where the cockpit renderer receives no keydown at
 * all and the native focus is in another process — so that claim can only come
 * from the main process, which is a SECOND owner. Writing one owner's list into
 * the other's would let a page's claim erase a palette's: open the command
 * palette over a focused browser tab and the palette's own ⌘1..⌘9 would go dead.
 *
 * SO THEY UNION, and the union is here — a pure module rather than four lines in
 * main.js, because main.js requires Electron at load and cannot be unit tested.
 * The rule this enforces is the one the repo cares most about: a suppression
 * that leaks leaves the rail's ⌘1..⌘9 dead with no way back but a restart.
 */
class ChordScopes {
  constructor() {
    /** The cockpit renderer's stack, mirrored whole on every announcement. */
    this.renderer = [];
    /** One entry per browser manager — two windows keep separate answers, and a
     *  window closing cannot leave the other's claim behind. */
    this.byOwner = new Map();
  }

  /**
   * The renderer re-announced its whole stack. Always replaces: an empty list is
   * a real answer ("nothing is claimed") and is how a reload gives the keys back.
   */
  setRenderer(chords) {
    this.renderer = onlyStrings(chords);
    return this.renderer;
  }

  /**
   * An owner in the main process took or released chords. Answers whether
   * anything actually CHANGED, so the caller can skip rebuilding the application
   * menu on every focus move between two tabs of the same browser.
   */
  setOwner(owner, chords) {
    const next = onlyStrings(chords);
    const previous = this.byOwner.get(owner) ?? [];
    if (same(previous, next)) return false;
    if (next.length === 0) this.byOwner.delete(owner);
    else this.byOwner.set(owner, next);
    return true;
  }

  /** Drop an owner entirely — its window is gone and it can no longer release. */
  forget(owner) {
    return this.byOwner.delete(owner);
  }

  /** Everything claimed right now, by either owner. Duplicates are harmless —
   *  `claimedCommandIds` normalizes and de-duplicates — but they are dropped
   *  here so the list a caller logs or compares is the honest set. */
  all() {
    const chords = [];
    for (const chord of [...this.renderer, ...[...this.byOwner.values()].flat()]) {
      if (!chords.includes(chord)) chords.push(chord);
    }
    return chords;
  }

  /** Nothing is claimed by anyone — the common case, and worth answering
   *  without building a list. */
  get empty() {
    return this.renderer.length === 0 && this.byOwner.size === 0;
  }
}

/** A renderer can send anything over IPC; a non-array reads as "nothing is
 *  claimed", which is the state that leaves every accelerator live. */
function onlyStrings(chords) {
  return Array.isArray(chords) ? chords.filter((chord) => typeof chord === "string") : [];
}

function same(a, b) {
  return a.length === b.length && a.every((chord, at) => chord === b[at]);
}

module.exports = { ChordScopes };
