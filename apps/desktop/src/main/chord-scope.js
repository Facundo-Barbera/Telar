class ChordScopes {
  constructor() {
    this.renderer = [];

    this.byOwner = new Map();
  }

  setRenderer(chords) {
    this.renderer = onlyStrings(chords);
    return this.renderer;
  }

  setOwner(owner, chords) {
    const next = onlyStrings(chords);
    const previous = this.byOwner.get(owner) ?? [];
    if (same(previous, next)) return false;
    if (next.length === 0) this.byOwner.delete(owner);
    else this.byOwner.set(owner, next);
    return true;
  }

  forget(owner) {
    return this.byOwner.delete(owner);
  }

  all() {
    const chords = [];
    for (const chord of [...this.renderer, ...[...this.byOwner.values()].flat()]) {
      if (!chords.includes(chord)) chords.push(chord);
    }
    return chords;
  }

  get empty() {
    return this.renderer.length === 0 && this.byOwner.size === 0;
  }
}

function onlyStrings(chords) {
  return Array.isArray(chords) ? chords.filter((chord) => typeof chord === "string") : [];
}

function same(a, b) {
  return a.length === b.length && a.every((chord, at) => chord === b[at]);
}

module.exports = { ChordScopes };
