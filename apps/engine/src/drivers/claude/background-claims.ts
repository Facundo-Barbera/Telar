import type { bindTasks } from "./task-tracker";
import { gateFor } from "./permission-gate";
import { type TaskSeed } from "@telar/engine-client";
import { type DriverSessionHooks } from "../contract";
import { type ClaudeRuntimeStore } from "./runtime";
import { type ClaudeTurnBindings } from "./sdk";
import { type TurnState, type Rest } from "./turn";
import { type ProviderTurnBinding } from "../contract";
import { type SdkCanUseTool } from "./sdk";

export type BackgroundClaim = {
  binding: ProviderTurnBinding;
  gate: SdkCanUseTool | undefined;
  /** Decisions being made under it right now. */
  inFlight: number;
  /** Resolves the next time `inFlight` reaches zero. */
  idle: Promise<void>;
  goneIdle: () => void;
  /** Armed once it is idle AND no background task is alive; cancelled by
   *  the next request. */
  linger: ReturnType<typeof setTimeout> | undefined;
};

const NO_CLAIM_FOR_BACKGROUND_WORK =
  "The turn that started this agent has ended, and this session has no live turn to decide the call under, so nothing ran. " +
  "Nobody declined it — there was nobody to ask. Report what you have; the call can be made again from a new turn.";

/** The result text the background claim's own turn settles with. It carries no
 *  prose — no model spoke in it — so it says what it was for. */
const BACKGROUND_CLAIM_RESULT = "Decided a tool call for background work still running after its turn ended.";

export const BACKGROUND_CLAIM_LINGER_MS = 5_000;

export type ClaimCtx = {
  turn: TurnState;
  backgroundClaimLingerMs: number;
  liveBackgroundTasks: ReturnType<typeof bindTasks>["liveBackgroundTasks"];
  runtimes: ClaudeRuntimeStore<ClaudeTurnBindings, TaskSeed>;
  sessionHooks: DriverSessionHooks | undefined;
  sessionId: string;
};

export const onClaimChain = <T>(ctx: ClaimCtx, step: () => Promise<T>): Promise<T> => {
  const next = ctx.turn.backgroundClaimChain.then(step, step);
  ctx.turn.backgroundClaimChain = next.then(() => undefined, () => undefined);
  return next;
};

export const acquireBackgroundClaim = (ctx: ClaimCtx): Promise<BackgroundClaim | undefined> =>
  onClaimChain(ctx, async () => {
    let claim = ctx.turn.backgroundClaim;
    if (!claim) {
      const live = ctx.liveBackgroundTasks();
      if (!ctx.sessionHooks || live.length === 0) return undefined;
      const binding = await ctx.sessionHooks
        .onProviderTurn({
          input: "",
          // Named when it can only be one task; a session with several
          // live children has no honest single answer.
          reason: { kind: "background_task", ...(live.length === 1 ? { taskId: live[0]!.id } : {}) },
        })
        .catch(() => undefined);
      // A human turn or a wake-up took the session first: it owns the
      // decision, and the gate below reads ITS binding instead.
      if (!binding) return undefined;
      // LIVE WORK, so the pool stops treating this process as spare —
      // the same reason the wake path sets it.
      ctx.runtimes.setWakeActive(ctx.sessionId, true);
      const opened: BackgroundClaim = {
        binding,
        gate: binding.onRequest ? gateFor(binding.onRequest) : undefined,
        inFlight: 0,
        idle: Promise.resolve(),
        goneIdle: () => undefined,
        linger: undefined,
      };
      // Somebody else wants the session — a person's message sent into
      // this turn. It is theirs once the decisions in flight are made.
      binding.wanted?.addEventListener("abort", () => void closeBackgroundClaim(ctx, opened).catch(() => undefined), { once: true });
      claim = ctx.turn.backgroundClaim = opened;
    }
    if (claim.linger !== undefined) {
      clearTimeout(claim.linger);
      claim.linger = undefined;
    }
    const acquired = claim;
    if (acquired.inFlight === 0) acquired.idle = new Promise<void>((resolve) => { acquired.goneIdle = resolve; });
    acquired.inFlight += 1;
    return acquired;
  });

export const closeBackgroundClaim = (ctx: ClaimCtx, only?: BackgroundClaim): Promise<void> =>
  onClaimChain(ctx, async () => {
    const claim = ctx.turn.backgroundClaim;
    if (!claim || (only && claim !== only)) return;
    if (claim.linger !== undefined) {
      clearTimeout(claim.linger);
      claim.linger = undefined;
    }
    if (claim.inFlight > 0) await claim.idle;
    ctx.turn.backgroundClaim = undefined;
    ctx.runtimes.setWakeActive(ctx.sessionId, false);
    await claim.binding.close({ text: BACKGROUND_CLAIM_RESULT }).catch(() => undefined);
  });

export const lingerOnceQuiet = (ctx: ClaimCtx, claim: BackgroundClaim): void => {
  if (claim !== ctx.turn.backgroundClaim || claim.inFlight > 0 || claim.linger !== undefined) return;
  if (ctx.liveBackgroundTasks().length > 0) return;
  claim.linger = setTimeout(() => { void closeBackgroundClaim(ctx, claim); }, ctx.backgroundClaimLingerMs);
  claim.linger.unref?.();
};

export const releaseBackgroundClaim = (ctx: ClaimCtx, claim: BackgroundClaim): void => {
  claim.inFlight -= 1;
  if (claim.inFlight > 0) return;
  claim.goneIdle();
  lingerOnceQuiet(ctx, claim);
};

export function bindClaims(ctx: ClaimCtx) {
  return {
    onClaimChain: (...args: Rest<typeof onClaimChain>) => onClaimChain(ctx, ...args),
    acquireBackgroundClaim: (...args: Rest<typeof acquireBackgroundClaim>) => acquireBackgroundClaim(ctx, ...args),
    closeBackgroundClaim: (...args: Rest<typeof closeBackgroundClaim>) => closeBackgroundClaim(ctx, ...args),
    lingerOnceQuiet: (...args: Rest<typeof lingerOnceQuiet>) => lingerOnceQuiet(ctx, ...args),
    releaseBackgroundClaim: (...args: Rest<typeof releaseBackgroundClaim>) => releaseBackgroundClaim(ctx, ...args),
  };
}

// The gate installed while no turn owns the session; it must stay one object, since callers compare against it.
export function createBackgroundGate(
  turn: TurnState,
  acquireBackgroundClaim: () => Promise<BackgroundClaim | undefined>,
  releaseBackgroundClaim: (claim: BackgroundClaim) => void,
): SdkCanUseTool {
  const backgroundGate: SdkCanUseTool = async (toolName, input, options) => {
    /** A turn of some kind has rebound the query's gate since it read the
     *  binding: that turn owns the session, and its claim is the live one. */
    const boundToATurn = (): SdkCanUseTool | undefined => {
      const bound = turn.runtimeRef?.bindings.current.canUseTool;
      return bound && bound !== backgroundGate ? bound : undefined;
    };
    const before = boundToATurn();
    if (before) return before(toolName, input, options);
    // NEVER THROWS OUT OF HERE. A permission callback that rejects blocks
    // the tool indefinitely with nothing to report it — `gateFor`'s own
    // rule, and the reason every failure below becomes a deny instead.
    const claim = await acquireBackgroundClaim().catch(() => undefined);
    if (!claim) {
      // The engine refused because a turn opened while we were asking —
      // it can decide this, and it is the right one to.
      const after = boundToATurn();
      if (after) return after(toolName, input, options);
      return { behavior: "deny", message: NO_CLAIM_FOR_BACKGROUND_WORK };
    }
    try {
      // A binding with no `onRequest` is the `full-access` shape, the same
      // answer the query's own gate gives a turn that carries none.
      return claim.gate ? await claim.gate(toolName, input, options) : { behavior: "allow" as const };
    } finally {
      releaseBackgroundClaim(claim);
    }
  };
  return backgroundGate;
}
