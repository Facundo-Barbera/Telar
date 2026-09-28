import { RunIcon, RunShell, type RunStopSignal, type RunView } from "@telar/engine-client";
import { z } from "zod";
import { err, failure, json, ok, type ToolFactory } from "../agent-tools";
import type { RunCapability, RunTarget } from "./capability";

function closedPhrase(run: RunView): string | undefined {
  if (run.status !== "closed") return undefined;
  const code = run.exitCode ?? run.signal;
  const exit = code === undefined ? "" : ` (exit ${code})`;
  if (run.closedBy === "person") return `Closed by the person${exit}. Do not reopen it unless they ask.`;
  if (run.closedBy === "telar") return `Closed by Telar${exit}.`;
  return `Closed by you${exit}.`;
}

function describe(run: RunView): string {
  const where = run.worktreeBranch ? `${run.worktreePath} (${run.worktreeBranch})` : run.worktreePath;
  const readiness =
    run.readiness.kind === "ready"
      ? ` — ${run.readinessUrl ?? "its ready pattern"} ${run.readinessUrl ? "is answering" : "was printed"}`
      : run.readiness.kind === "pending"
        ? ` — waiting for ${run.readinessUrl ?? "its ready pattern"}`
        : run.readiness.kind === "unattributable"
          ? ` — readiness cannot be attributed to this process (${run.readiness.reason})`
          : "";
  const closed = closedPhrase(run);
  const ended = closed ? ` ${closed}` : run.endedAt ? ` exit ${run.exitCode ?? run.signal ?? "?"}.` : "";
  const warning = run.warning ? ` Warning: ${run.warning}.` : "";
  return `"${run.title}" is ${run.status} (terminal ${run.terminalId}) from ${where}, cwd ${run.cwd}.${readiness}${ended}${warning}${run.error ? ` ${run.error}` : ""}`;
}

const lineText = (lines: { stream: string; text: string }[]) => lines.map((line) => (line.stream === "stderr" ? `! ${line.text}` : line.text)).join("\n");

const SIGNAL = z
  .enum(["SIGTERM", "SIGINT", "SIGKILL"])
  .optional()
  .describe("A first signal before the close, e.g. SIGINT for a server that only stops on Ctrl-C. The close follows regardless.");

const signalOf = (value: unknown): RunStopSignal | undefined => (value === "SIGTERM" || value === "SIGINT" || value === "SIGKILL" ? value : undefined);

function runToolsContext(tool: ToolFactory, capability: RunCapability) {
  const personClosed = async (terminalId: string | undefined): Promise<string | undefined> => {
    if (!terminalId) return undefined;
    try {
      const run = (await capability.status()).terminals.find((entry) => entry.terminalId === terminalId);
      return run?.status === "closed" && run.closedBy === "person" ? closedPhrase(run) : undefined;
    } catch {
      return undefined;
    }
  };
  const idOf = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
  const target = (terminalId: string | undefined): RunTarget => (terminalId ? { terminalId } : {});
  const list = async () => {
    try {
      const status = await capability.status();
      const terminals = status.terminals;
      const where = status.sessionWorktreePath ? `\nThis session's worktree: ${status.sessionWorktreePath}` : "";
      if (!terminals.length) return ok(`This session has no terminals.${where}`);
      return ok(`${terminals.map((run) => `- ${describe(run)}`).join("\n")}${where}`);
    } catch (error) {
      return err(`Could not list the terminals: ${failure(error)}`);
    }
  };
  const opened = (run: RunView) =>
    ok(`Opened ${describe(run)}\nterminalId: ${run.terminalId}. Read it with terminal_output; wait on it with terminal_wait.`);
  const openFromConfig = async (configId: string) => {
    try {
      return opened(await capability.start({ configId, openedBy: "agent" }));
    } catch (error) {
      return err(`Did not open: ${failure(error)}`);
    }
  };
  const kill = async (terminalId: string | undefined, signal: unknown) => {
    const first = signalOf(signal);
    try {
      const run = await capability.stop({ ...target(terminalId), ...(first ? { signal: first } : {}), closedBy: "agent" });
      return ok(`Closed ${describe(run)}`);
    } catch (error) {
      return err(`Did not close: ${failure(error)}`);
    }
  };
  const output = async (terminalId: string | undefined, args: Record<string, unknown>) => {
    try {
      const result = await capability.output({
        ...target(terminalId),
        ...(typeof args.after === "number" ? { after: args.after } : {}),
        ...(typeof args.tail === "number" ? { tail: args.tail } : {}),
        ...(typeof args.grep === "string" ? { grep: args.grep } : {}),
        ...(args.stream === "stdout" || args.stream === "stderr" ? { stream: args.stream } : {}),
      });
      const body = lineText(result.lines);
      const dropped = result.dropped ? `[${result.dropped} earlier line(s) dropped]\n` : "";
      const narrowed = args.tail !== undefined || args.grep !== undefined || args.stream !== undefined;
      const empty = narrowed ? "(no line in this window matched)" : "(no output yet)";
      const closed = await personClosed(terminalId);
      return ok(`${closed ? `${closed}\n` : ""}${dropped}${body || empty}\n[cursor ${result.cursor}]`);
    } catch (error) {
      return err(`Could not read the output: ${failure(error)}`);
    }
  };
  const wait = async (terminalId: string | undefined, args: Record<string, unknown>) => {
    if (args.pattern === undefined && args.ready !== true && args.exit !== true) {
      return err("Give something to wait FOR: pattern, ready or exit. Waiting for nothing is a sleep, which is what this tool replaces.");
    }
    try {
      const result = await capability.wait({
        ...target(terminalId),
        ...(typeof args.pattern === "string" ? { pattern: args.pattern } : {}),
        ...(args.ready === true ? { ready: true } : {}),
        ...(args.exit === true ? { exit: true } : {}),
        timeoutMs: Number(args.timeoutMs),
      });
      const closed = result.fired === "exit" ? await personClosed(terminalId) : undefined;
      const verdict =
        result.fired === "timeout"
          ? "TIMED OUT — the condition did not happen in the time given. It may still be starting; do not assume it is up."
          : result.fired === "ready"
            ? "READY — it reported ready."
            : result.fired === "exit"
              ? closed
                ? `ENDED — ${closed}`
                : "ENDED — the terminal is no longer running; terminal_list says how."
              : "MATCHED — a line matched your pattern.";
      return ok(`${verdict}\n${lineText(result.lines) || "(nothing was printed while waiting)"}\n[cursor ${result.cursor}]`);
    } catch (error) {
      return err(`Could not wait on that terminal: ${failure(error)}`);
    }
  };
  const OUTPUT_SHAPE = {
    after: z.number().int().min(0).optional().describe("A cursor from an earlier call; only newer lines come back."),
    tail: z.number().int().min(1).max(1000).optional().describe("Only the last N lines. The end is usually where it says what went wrong."),
    grep: z.string().min(1).max(500).optional().describe("A regular expression; only matching lines come back. The cursor still advances over the rest."),
    stream: z.enum(["stdout", "stderr"]).optional().describe("One stream only. A terminal has only stdout: the two are merged before Telar sees them."),
  };
  const WAIT_SHAPE = {
    pattern: z.string().min(1).max(500).optional().describe("A regular expression over lines printed from now on, e.g. 'Ready in|Listening on'."),
    ready: z.boolean().optional().describe("Wait for its readiness URL or ready pattern. Refused if it has neither."),
    exit: z.boolean().optional().describe("Wait for it to end, e.g. a build or a test run."),
    timeoutMs: z.number().int().min(0).max(60_000).describe("How long to wait, at most 60000. Pick a budget and handle a timeout."),
  };
  return { idOf, list, opened, openFromConfig, kill, output, wait, OUTPUT_SHAPE, WAIT_SHAPE };
}

export function runTools(tool: ToolFactory, capability: RunCapability): unknown[] {
  const h = runToolsContext(tool, capability);
  return [
    ...terminalTools(tool, capability, h),
    ...configTools(tool, capability),
  ];
}

function terminalTools(tool: ToolFactory, capability: RunCapability, h: ReturnType<typeof runToolsContext>): unknown[] {
  const { idOf, list, opened, openFromConfig, kill, output, wait, OUTPUT_SHAPE, WAIT_SHAPE } = h;
  return [
    tool(
      "terminal_open",
      "Open a NEW terminal in this session's panel, where the person sees it, running a command: a dev server, a watcher, a long build. Pass command (with cwd, name, ready) or a saved configId. Returns its terminalId. Use this, never a background shell or '&', for anything that keeps running.",
      {
        command: z.string().min(1).max(4000).optional().describe("The shell command, e.g. 'bun run dev'."),
        cwd: z.string().max(1024).optional().describe("Directory relative to this session's worktree. Default: its root."),
        name: z.string().min(1).max(120).optional().describe("The tab's title. Default: the start of the command."),
        ready: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe("An http(s) URL that answers once it is up, or a regular expression its output prints when it is, e.g. 'Listening on'."),
        configId: z.string().min(1).optional().describe("Open a saved run configuration instead of a command (see run_configs)."),
      },
      async (args) => {
        const configId = idOf(args.configId);
        const command = typeof args.command === "string" ? args.command : undefined;
        if (configId && command) return err("Give a command or a configId, not both.");
        if (configId) return await openFromConfig(configId);
        if (!command) return err("terminal_open needs a command, or the configId of a saved run configuration.");
        const ready = typeof args.ready === "string" ? args.ready : undefined;
        const url = ready !== undefined && /^https?:\/\//i.test(ready);
        try {
          const run = await capability.open({
            command,
            ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
            ...(typeof args.name === "string" ? { name: args.name } : {}),
            ...(ready === undefined ? {} : url ? { readinessUrl: ready } : { readyPattern: ready }),
          });
          return opened(run);
        } catch (error) {
          return err(`Did not open: ${failure(error)}`);
        }
      },
    ),

    tool(
      "terminal_list",
      "This session's terminals, newest first: open ones and recently ended, each with its terminalId, status, where it runs and who closed it. One the person closed stays closed unless they ask you to reopen it.",
      {},
      async () => await list(),
    ),

    tool(
      "terminal_output",
      "What a terminal printed, including after it ended. A bounded window; dropped lines are counted. Pass the cursor from an earlier call to read only what is new. tail, grep and stream narrow the answer without moving the cursor.",
      { terminalId: z.string().min(1).describe("Which terminal (see terminal_list)."), ...OUTPUT_SHAPE },
      async (args) => await output(idOf(args.terminalId), args),
    ),

    tool(
      "terminal_wait",
      "Wait until a terminal prints a pattern, becomes ready, or ends. This is how you wait for a server: never sleep. Give pattern, ready or exit, and timeoutMs. The answer says which fired or that it timed out, with the lines printed meanwhile and a cursor.",
      { terminalId: z.string().min(1).describe("Which terminal (see terminal_list)."), ...WAIT_SHAPE },
      async (args) => await wait(idOf(args.terminalId), args),
    ),

    tool(
      "terminal_kill",
      "Close a terminal, which ends everything running in it (the whole process group). It is recorded as closed by you. This is the only way to stop one: never pkill, killall or kill.",
      { terminalId: z.string().min(1).describe("Which terminal (see terminal_list)."), signal: SIGNAL },
      async (args) => await kill(idOf(args.terminalId), args.signal),
    ),
  ];
}

function configTools(tool: ToolFactory, capability: RunCapability): unknown[] {
  const forget = async (configId: unknown) => {
    if (typeof configId !== "string" || !configId) return err("delete needs the configId to forget.");
    try {
      await capability.removeConfiguration(configId);
      return ok("Removed that run configuration.");
    } catch (error) {
      return err(`Could not remove that run configuration: ${failure(error)}`);
    }
  };
  return [
    tool(
      "run_configs",
      "The project's saved run configurations: name, icon, command, working directory and which environment variables are set. Secret values are never returned. A project usually already has the recipe you want; open one with terminal_open({configId}).",
      {},
      async () => {
        try {
          const configs = await capability.configurations();
          if (!configs.length) return ok("This project has no saved run configurations yet. Create one with run_save_config.");
          return json(configs);
        } catch (error) {
          return err(`Could not read the run configurations: ${failure(error)}`);
        }
      },
    ),

    tool(
      "run_save_config",
      "Save a run configuration on the PROJECT, shown in its Run menu, or edit one by passing its configId. You can set up an empty Run menu yourself. The cwd is relative to the worktree it is opened from. Give a readinessUrl only if the command really serves it.",
      {
        configId: z.string().min(1).optional().describe("Edit this configuration instead of creating one."),
        delete: z.boolean().optional().describe("Forget configId. A terminal already opened from it keeps running."),
        name: z.string().min(1).max(120).optional().describe("What a human picks in the Run menu, e.g. 'web dev'."),
        icon: RunIcon.optional().describe("The glyph the Run menu draws before the name. Default: 'play'."),
        command: z.string().min(1).optional().describe("The shell command, e.g. 'bun run dev'."),
        shell: RunShell.optional().describe(
          "Which program evaluates the command, spelled out: it is spawned with args followed by the command, e.g. {program:'/bin/bash', args:['-lc']}. Leave it out unless the recipe genuinely needs a particular shell — an absent one is resolved against whatever platform the run launches on, which is what keeps a recipe openable on another machine.",
        ),
        cwd: z.string().optional().describe("Directory relative to the worktree root, e.g. 'apps/web'. Default: the root."),
        env: z
          .array(z.object({ key: z.string().min(1), value: z.string(), secret: z.boolean().optional() }))
          .optional()
          .describe("Environment variables. Mark a value secret to keep it out of every read and out of captured output."),
        readinessUrl: z.string().url().optional().describe("A URL that answers once the service is up, e.g. 'http://localhost:3000'."),
      },
      async (args) => {
        if (args.delete === true) return await forget(args.configId);
        const patch = {
          ...(typeof args.name === "string" ? { name: args.name } : {}),
          ...(RunIcon.safeParse(args.icon).success ? { icon: args.icon as RunIcon } : {}),
          ...(typeof args.command === "string" ? { command: args.command } : {}),
          ...(RunShell.safeParse(args.shell).success ? { shell: RunShell.parse(args.shell) } : {}),
          ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
          ...(Array.isArray(args.env) ? { env: args.env as { key: string; value: string; secret?: boolean }[] } : {}),
          ...(typeof args.readinessUrl === "string" ? { readinessUrl: args.readinessUrl } : {}),
        };
        try {
          if (typeof args.configId === "string") {
            const updated = await capability.updateConfiguration(args.configId, patch);
            return ok(`Updated "${updated.name}" (${updated.id}): ${updated.command}`);
          }
          if (!patch.name || !patch.command) return err("A new run configuration needs at least a name and a command.");
          const created = await capability.createConfiguration({ name: patch.name, command: patch.command, ...patch });
          return ok(`Saved "${created.name}" (${created.id}): ${created.command}${created.cwd ? ` in ${created.cwd}` : ""}.`);
        } catch (error) {
          return err(`Could not save that run configuration: ${failure(error)}`);
        }
      },
    ),
  ];
}
