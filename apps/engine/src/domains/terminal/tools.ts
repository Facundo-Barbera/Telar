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
  .describe("Sent first, e.g. SIGINT; the close follows regardless.");

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
    after: z.number().int().min(0).optional().describe("Cursor from an earlier call."),
    tail: z.number().int().min(1).max(1000).optional().describe("Only the last N lines."),
    grep: z.string().min(1).max(500).optional().describe("Regex; only matching lines."),
    stream: z.enum(["stdout", "stderr"]).optional().describe("One stream only."),
  };
  const WAIT_SHAPE = {
    pattern: z.string().min(1).max(500).optional().describe("Regex over new lines, e.g. 'Listening on'."),
    ready: z.boolean().optional().describe("Wait for its ready URL or pattern."),
    exit: z.boolean().optional().describe("Wait for it to exit."),
    timeoutMs: z.number().int().min(0).max(60_000).describe("At most 60000."),
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
      "Open a terminal in the panel running a command (dev server, watcher, long build) or a saved configId. Use this, never '&' or a background shell, for anything long-running.",
      {
        command: z.string().min(1).max(4000).optional().describe("e.g. 'bun run dev'."),
        cwd: z.string().max(1024).optional().describe("Relative to the worktree."),
        name: z.string().min(1).max(120).optional().describe("Tab title."),
        ready: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe("A URL that answers, or a regex printed, once it is up."),
        configId: z.string().min(1).optional().describe("A saved run configuration."),
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
      "This session's terminals, newest first, with status and who closed each. Don't reopen one the person closed unless they ask.",
      {},
      async () => await list(),
    ),

    tool(
      "terminal_output",
      "What a terminal printed, even after it ended. Pass the last cursor to read only new lines; tail, grep and stream narrow without moving it.",
      { terminalId: z.string().min(1).describe("From terminal_open or terminal_list."), ...OUTPUT_SHAPE },
      async (args) => await output(idOf(args.terminalId), args),
    ),

    tool(
      "terminal_wait",
      "Wait until a terminal prints a pattern, is ready, or exits; never sleep instead. Says which fired or that it timed out.",
      { terminalId: z.string().min(1).describe("From terminal_open or terminal_list."), ...WAIT_SHAPE },
      async (args) => await wait(idOf(args.terminalId), args),
    ),

    tool(
      "terminal_kill",
      "Close a terminal and everything running in it. The only way to stop one: never pkill, killall or kill.",
      { terminalId: z.string().min(1).describe("From terminal_open or terminal_list."), signal: SIGNAL },
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
      "The project's saved run configurations (secrets hidden). Open one with terminal_open({configId}).",
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
      "Create or edit (configId) a run configuration in the project's Run menu; an empty menu is yours to fill.",
      {
        configId: z.string().min(1).optional().describe("Edit this one."),
        delete: z.boolean().optional().describe("Forget configId; its open terminals keep running."),
        name: z.string().min(1).max(120).optional().describe("Menu label, e.g. 'web dev'."),
        icon: RunIcon.optional().describe("Default 'play'."),
        command: z.string().min(1).optional().describe("e.g. 'bun run dev'."),
        shell: RunShell.strict().optional().describe(
          "Only if it needs a specific shell, e.g. {program:'/bin/bash', args:['-lc']}.",
        ),
        cwd: z.string().optional().describe("Relative to the worktree root."),
        env: z
          .array(z.strictObject({ key: z.string().min(1), value: z.string(), secret: z.boolean().optional() }))
          .optional()
          .describe("Mark secret values secret."),
        readinessUrl: z.string().url().optional().describe("Only if the command serves it."),
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
