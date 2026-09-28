
export const REVEAL = {
  maxLagMs: 1200,
  reserveMs: 450,
  reserveFloorChars: 2,
  drainSlack: { min: 0.25, max: 2 },
  arrivalWeight: 0.3,
} as const;

export type RevealConfig = typeof REVEAL;

type Pending = { end: number; at: number };

export type RevealState = {
  shown: number;
  target: number;
  pending: Pending[];
  last: number;
  arrivedAt?: number;
  arrival?: number;
};

export function revealState(length: number, now = 0): RevealState {
  return { shown: length, target: length, pending: [], last: now };
}

const carry = (state: RevealState) => ({
  ...(state.arrivedAt === undefined ? {} : { arrivedAt: state.arrivedAt }),
  ...(state.arrival === undefined ? {} : { arrival: state.arrival }),
});

function advanceReveal(state: RevealState, now: number, config: RevealConfig = REVEAL): RevealState {
  const elapsed = Math.max(0, now - state.last);
  const pending = state.pending.filter((chunk) => chunk.end > state.shown);
  if (pending.length === 0) return { shown: state.target, target: state.target, pending: [], last: now, ...carry(state) };

  let base = state.shown;
  for (const chunk of pending) if (chunk.at + config.maxLagMs - now <= 0) base = Math.max(base, chunk.end);

  let required = 0;
  for (const chunk of pending) {
    const left = chunk.at + config.maxLagMs - now;
    if (left > 0 && chunk.end > base) required = Math.max(required, ((chunk.end - base) * 1000) / left);
  }
  let sustained = 0;
  if (state.arrival !== undefined) {
    const backlog = state.target - Math.max(base, state.shown);
    const reserve = Math.max(config.reserveFloorChars, (state.arrival * config.reserveMs) / 1000);
    const pressure = Math.min(config.drainSlack.max, Math.max(config.drainSlack.min, backlog / reserve));
    sustained = state.arrival * pressure;
  }
  const rate = Math.max(required, sustained);
  const shown = Math.min(state.target, Math.max(base, state.shown + (rate * elapsed) / 1000));
  return { shown, target: state.target, pending: pending.filter((chunk) => chunk.end > shown), last: now, ...carry(state) };
}

function ingestReveal(state: RevealState, target: number, now: number, config: RevealConfig = REVEAL): RevealState {
  if (target < state.shown) return revealState(target, now);
  if (target <= state.target) return state;
  let arrival = state.arrival;
  if (state.arrivedAt !== undefined && now > state.arrivedAt) {
    const sample = ((target - state.target) * 1000) / (now - state.arrivedAt);
    arrival = arrival === undefined ? sample : arrival * (1 - config.arrivalWeight) + sample * config.arrivalWeight;
  }
  return {
    shown: state.shown,
    target,
    pending: [...state.pending, { end: target, at: now }],
    last: state.last,
    arrivedAt: now,
    ...(arrival === undefined ? {} : { arrival }),
  };
}

export function stepReveal(state: RevealState, target: number, now: number, config: RevealConfig = REVEAL): RevealState {
  if (target < state.shown) return revealState(target, now);
  return ingestReveal(advanceReveal(state, now, config), target, now, config);
}

export function revealText(target: string, shown: number): string {
  let end = Math.floor(Math.max(0, shown));
  if (end >= target.length) return target;
  if (end > 0 && /[\uD800-\uDBFF]/.test(target[end - 1]!)) end += 1;
  return target.slice(0, end);
}
