/**
 * THE PROOF PLUGIN. It does nothing useful on purpose.
 *
 * Its whole job is to answer one question with code rather than with an
 * argument: CAN A NEW FEATURE ARRIVE WITHOUT A SINGLE FEATURE-SPECIFIC BRANCH IN
 * THE CORE? If adding `hello` requires touching `driver.ts`, `daemon.ts`,
 * `state.ts` or the protocol, the host is not a host — it is a third hardcoded
 * case with extra ceremony, and we would have learned that here instead of
 * halfway through migrating Data Science.
 *
 * So it exercises exactly the seams a real plugin uses, and no more:
 *
 *   - a manifest with its own tool prefix and its own settings section
 *   - a settings schema the host validates writes against
 *   - an `init` that acquires something and registers its cleanup
 *   - `drain` / `busy` / `releaseProject`, with work that takes real time, so
 *     the disable-means-drain promise has something to be true about
 *   - a durable work breadcrumb, so an interrupted "job" is reported honestly
 *   - a tool wall built on the ordinary `ToolFactory`
 *
 * NOT REGISTERED BY DEFAULT. It is gated behind `TELAR_PLUGIN_HELLO=1` because a
 * proof plugin visible to every model in every session is a junk tool in a real
 * product. The gate is on registration, not on the code path being tested — with
 * the variable set it goes through exactly what LaTeX goes through.
 */
import { z } from "zod";
import type { PluginMeta } from "@telar/engine-client";
import { PLUGIN_API_VERSION } from "@telar/engine-client";
import { err, json, ok, type ToolFactory } from "../tool-kit";
import type { PluginEngineModule, PluginInitContext } from "./contract";
import type { PluginToolModule } from "./tool-module";
import type { PluginWorkLog } from "./work-log";

const HelloSettings = z.object({
  /** Deliberately trivial — the point is that the plugin owns the shape. */
  greeting: z.string().min(1).max(200).default("hello"),
  slowMs: z.number().int().min(0).max(60_000).default(50),
});
export type HelloSettings = z.infer<typeof HelloSettings>;

export const helloMeta: PluginMeta = {
  id: "hello",
  api: PLUGIN_API_VERSION,
  name: "Hello",
  version: "0.1.0",
  blurb: "A proof plugin. Registers a tool and a settings page, and nothing else.",
  toolPrefixes: ["hello"],
  // Claims nothing. A proof plugin asking for an approval exemption would be
  // proving the wrong thing.
  readTools: [],
  eventKinds: ["greeted"],
  settings: [{ id: "hello", scope: "project", label: "Hello", blurb: "The proof plugin's one setting." }],
};

/** Per-project pretend work, so `busy` has something to report. */
type HelloWork = { projectId: string; done: Promise<void>; workId: string };

export class HelloRuntime {
  private readonly running = new Map<string, HelloWork[]>();
  private readonly draining = new Set<string>();
  private sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly work: PluginWorkLog) {}

  startSweeper(): void {
    this.sweeper = setInterval(() => {
      for (const [projectId, jobs] of this.running) if (jobs.length === 0) this.running.delete(projectId);
    }, 30_000);
    this.sweeper.unref?.();
  }

  stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  /** Refuses once drained — the observable half of "prevent new work". */
  begin(projectId: string, sessionId: string, ms: number): HelloWork | { refused: string } {
    if (this.draining.has(projectId)) return { refused: "Hello is switched off for this project." };
    const workId = this.work.begin({ plugin: "hello", sessionId, kind: "greet", label: `${ms}ms` });
    const job: HelloWork = {
      projectId,
      workId,
      done: new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.work.end(workId);
          const jobs = this.running.get(projectId) ?? [];
          this.running.set(
            projectId,
            jobs.filter((entry) => entry.workId !== workId),
          );
          resolve();
        }, ms);
        timer.unref?.();
      }),
    };
    this.running.set(projectId, [...(this.running.get(projectId) ?? []), job]);
    return job;
  }

  drain(projectId: string): void {
    this.draining.add(projectId);
  }

  busy(projectId: string): boolean {
    return (this.running.get(projectId) ?? []).length > 0;
  }

  releaseProject(projectId: string): void {
    this.running.delete(projectId);
    this.draining.delete(projectId);
  }

  releaseSession(): void {
    /* nothing per-session to give back */
  }
}

/**
 * WHAT ONE SESSION SEES OF THE PLUGIN — the capability port, same pattern as
 * `ds/capability.ts` and `latex/capability.ts`. The module is built ONCE at
 * daemon startup and cannot close over a session, so everything session-shaped
 * arrives through here, resolved per request.
 */
export type HelloCapability = {
  ping(input?: { name?: string }): Promise<{ greeted: string }>;
  state(): Promise<{ busy: boolean }>;
};

/** Where the plugin's gate is answered: which project, and did it opt in. */
export type HelloSession = { projectId: string; sessionId: string };

/** The daemon-side implementation — the runtime, directly. */
function storeHelloCapability(runtime: () => HelloRuntime | undefined, session: HelloSession): HelloCapability {
  return {
    async ping(input) {
      const started = runtime()?.begin(session.projectId, session.sessionId, 0);
      if (started && "refused" in started) throw new Error(started.refused);
      await started?.done;
      return { greeted: input?.name ?? "world" };
    },
    async state() {
      return { busy: runtime()?.busy(session.projectId) ?? false };
    },
  };
}

/**
 * THE WALL. Pure over the port, capturing no daemon object — which is what lets
 * the worker register it against an HTTP-backed capability while the daemon's
 * own tests register it against a store-backed one, from this one definition.
 */
export const helloToolModule: PluginToolModule = {
  meta: helloMeta,
  capability: (call) => ({
    ping: (input?: { name?: string }) => call<{ greeted: string }>("ping", input ?? {}),
    state: () => call<{ busy: boolean }>("state"),
  }),
  tools(tool: ToolFactory, capability: unknown) {
    const hello = capability as HelloCapability;
    return [
      tool(
        "hello_ping",
        "Answer with the project's configured greeting. A proof tool; it changes nothing.",
        { name: z.string().min(1).max(80).optional().describe("Who to greet.") },
        async (args) => {
          try {
            const answer = await hello.ping(typeof args.name === "string" ? { name: args.name } : {});
            return ok(`hello, ${answer.greeted}`);
          } catch (error) {
            return err(error instanceof Error ? error.message : String(error));
          }
        },
      ),
      tool("hello_state", "Whether the proof plugin has work running for this project.", {}, async () => json(await hello.state())),
    ];
  },
};

export function helloPlugin(deps: {
  /** Throws when the project has not opted in — the gate, same as `store.latex`. */
  resolve: (sessionId: string) => HelloSession;
}): PluginEngineModule<HelloSettings> {
  let runtime: HelloRuntime | undefined;
  return {
    meta: helloMeta,
    settingsSchema: HelloSettings,
    resolve: (sessionId) => storeHelloCapability(() => runtime, deps.resolve(sessionId)),
    init(context: PluginInitContext) {
      runtime = new HelloRuntime(context.work);
      runtime.startSweeper();
      // REGISTERED AS IT IS ACQUIRED. If a later line of this hook threw, the
      // host would still stop the interval — which is the property the whole
      // `onDispose` register exists for.
      context.onDispose("hello sweeper", () => runtime?.stopSweeper());
    },
    hooks: {
      drain: (projectId) => runtime?.drain(projectId),
      busy: (projectId) => runtime?.busy(projectId) ?? false,
      releaseProject: (projectId) => runtime?.releaseProject(projectId),
      releaseSession: () => runtime?.releaseSession(),
    },
    /**
     * The HTTP door is the SAME object the tool wall talks to — literally what
     * `resolve` returned. That is what keeps the two doors from drifting: the
     * worker's wall reaches these routes over the wire, and these routes are one
     * line each.
     */
    routes: {
      ping: (input, capability) => (capability as HelloCapability).ping(input as { name?: string }),
      state: (_input, capability) => (capability as HelloCapability).state(),
    },
  };
}
