export type ScopeGuard = {
  bump(): void;
  capture(): number;
  isCurrent(captured: number): boolean;
};

export function makeScopeGuard(): ScopeGuard {
  let generation = 0;
  return {
    bump() {
      generation += 1;
    },
    capture() {
      return generation;
    },
    isCurrent(captured) {
      return captured === generation;
    },
  };
}
