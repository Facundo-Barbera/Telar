import { z } from "zod";
import type { PluginMeta } from "@telar/engine-client";
import { PLUGIN_API_VERSION } from "@telar/engine-client";
import { err, json, ok, type ToolFactory } from "../agent-tools";
import type { PluginEngineModule, PluginInitContext } from "./contract";
import type { PluginToolModule } from "./tool-module";
import type { PluginWorkLog } from "./work-log";

const HelloSettings = z.object({
  greeting: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .meta({ title: "Greeting", description: "What the proof tool answers with in this project.", inherits: "greeting" }),
  slowMs: z
    .number()
    .int()
    .min(0)
    .max(60_000)
    .default(50)
    .meta({
      title: "Pretend work",
      description: "How long each greeting takes, in milliseconds.",
      info: "Long enough to see a disabled plugin drain rather than stop.",
    }),
});

const HelloMachineSettings = z.object({
  greeting: z.string().min(1).max(200).optional().meta({ title: "Greeting", description: "What the proof tool answers with, unless a project says otherwise." }),
});
export type HelloSettings = z.infer<typeof HelloSettings>;

const helloMeta: PluginMeta = {
  id: "hello",
  api: PLUGIN_API_VERSION,
  name: "Hello",
  version: "0.1.0",
  blurb: "A proof plugin. Registers a tool and a settings page, and nothing else.",
  toolPrefixes: ["hello"],
  readTools: [],
  eventKinds: ["greeted"],
  settings: [
    { id: "hello", scope: "project", label: "Hello", blurb: "The proof plugin's settings for this project." },
    { id: "defaults", scope: "machine", label: "Hello", blurb: "What every project inherits on this computer." },
  ],
};

type HelloWork = { projectId: string; done: Promise<void>; workId: string };

class HelloRuntime {
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
  }
}

export type HelloCapability = {
  ping(input?: { name?: string }): Promise<{ greeted: string }>;
  state(): Promise<{ busy: boolean }>;
};

export type HelloSession = { projectId: string; sessionId: string };

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
  resolve: (sessionId: string) => HelloSession;
}): PluginEngineModule<HelloSettings> {
  let runtime: HelloRuntime | undefined;
  return {
    meta: helloMeta,
    settingsSchema: HelloSettings,
    machineSettingsSchema: HelloMachineSettings,
    resolve: (sessionId) => storeHelloCapability(() => runtime, deps.resolve(sessionId)),
    init(context: PluginInitContext) {
      runtime = new HelloRuntime(context.work);
      runtime.startSweeper();
      context.onDispose("hello sweeper", () => runtime?.stopSweeper());
    },
    hooks: {
      drain: (projectId) => runtime?.drain(projectId),
      busy: (projectId) => runtime?.busy(projectId) ?? false,
      releaseProject: (projectId) => runtime?.releaseProject(projectId),
      releaseSession: () => runtime?.releaseSession(),
    },
    routes: {
      ping: (input, capability) => (capability as HelloCapability).ping(input as { name?: string }),
      state: (_input, capability) => (capability as HelloCapability).state(),
    },
  };
}
