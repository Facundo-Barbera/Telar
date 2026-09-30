"use client";

import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent } from "react";
import { BoxesIcon, FileWarningIcon, NetworkIcon, PackageIcon, TerminalIcon, VariableIcon } from "lucide-react";
import {
  resolveWorkspace,
  type ProjectWorkspaceOverrides,
  type ProjectWorkspaceView,
  type WorkspaceArtifact,
  type WorkspaceDependencies,
  type WorkspacePorts,
  type WorkspaceSetup,
  type WorkspaceSource,
} from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Switch } from "@/ui/switch";
import { Textarea } from "@/ui/textarea";
import { cn } from "@/ui/utils";
import { Dropdown, Row, SettingsGroup } from "@/features/settings";

const api = createEngineApi();

export type WorkspaceRowField = "setup" | "env" | "ports" | "dependencies" | "artifacts";
type ModeField = Exclude<WorkspaceRowField, "dependencies">;
type TextField = Exclude<ModeField, "setup">;
type Values = {
  setup: WorkspaceSetup;
  env: Record<string, string>;
  ports: WorkspacePorts;
  artifacts: WorkspaceArtifact[];
};
type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

function numberedLines(text: string): { line: string; at: number }[] {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), at: index + 1 }))
    .filter((entry) => entry.line.length > 0);
}

function formatEnv(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export function parseEnv(text: string): Parsed<Record<string, string> | undefined> {
  const env: Record<string, string> = {};
  for (const { line, at } of numberedLines(text)) {
    const split = line.indexOf("=");
    if (split <= 0) return { ok: false, message: `Line ${at}: expected KEY=value.` };
    env[line.slice(0, split).trim()] = line.slice(split + 1).trim();
  }
  return { ok: true, value: Object.keys(env).length > 0 ? env : undefined };
}

function formatPorts(ports: WorkspacePorts | undefined): string {
  return ports?.names.join(", ") ?? "";
}

export function parsePorts(text: string, previous?: WorkspacePorts): Parsed<WorkspacePorts | undefined> {
  const names = text.split(/[\s,]+/).filter(Boolean);
  if (names.length === 0) return { ok: true, value: undefined };
  return { ok: true, value: { names, ...(previous?.base !== undefined ? { base: previous.base } : {}) } };
}

const ARTIFACT_SEPARATOR = "=>";

export function formatArtifacts(artifacts: WorkspaceArtifact[] | undefined): string {
  return (artifacts ?? [])
    .map((entry) => (entry.regen ? `${entry.path} ${ARTIFACT_SEPARATOR} ${entry.regen}` : entry.path))
    .join("\n");
}

export function parseArtifacts(text: string): Parsed<WorkspaceArtifact[] | undefined> {
  const artifacts: WorkspaceArtifact[] = [];
  for (const { line, at } of numberedLines(text)) {
    const split = line.indexOf(ARTIFACT_SEPARATOR);
    const path = (split < 0 ? line : line.slice(0, split)).trim();
    const regen = split < 0 ? "" : line.slice(split + ARTIFACT_SEPARATOR.length).trim();
    if (!path) return { ok: false, message: `Line ${at}: a path comes before ${ARTIFACT_SEPARATOR}.` };
    artifacts.push(regen ? { path, regen } : { path });
  }
  return { ok: true, value: artifacts.length > 0 ? artifacts : undefined };
}

function formatSetup(setup: WorkspaceSetup | undefined): string {
  if (!setup) return "";
  return [
    setup.command,
    setup.blocking ? "Holds the first turn until it finishes." : undefined,
    setup.timeoutMs ? `Stops after ${setup.timeoutMs / 1000} s.` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

type TextSpec<F extends TextField> = {
  format: (value: Values[F] | undefined) => string;
  parse: (text: string, previous: Values[F] | undefined) => Parsed<Values[F] | undefined>;
  empty?: Values[F];
  required?: string;
  placeholder: string;
  multiline: boolean;
};

const TEXT: { [F in TextField]: TextSpec<F> } = {
  env: { format: formatEnv, parse: parseEnv, empty: {}, placeholder: "KEY=value", multiline: true },
  ports: {
    format: formatPorts,
    parse: parsePorts,
    required: "Name at least one port.",
    placeholder: "PORT, WEB_PORT",
    multiline: false,
  },
  artifacts: {
    format: formatArtifacts,
    parse: parseArtifacts,
    empty: [],
    placeholder: `path ${ARTIFACT_SEPARATOR} regen command`,
    multiline: true,
  },
};

const ROWS: { field: ModeField; label: string; icon: ComponentType<{ className?: string }>; hint: string; info?: string }[] = [
  { field: "setup", label: "Setup", icon: TerminalIcon, hint: "Runs in the background in each new worktree, with the variables and ports below." },
  {
    field: "env",
    label: "Environment",
    icon: VariableIcon,
    hint: "Exported to the setup command.",
    info: "Merges by key: this Mac < the repo's .telar/workspace.json < this project.",
  },
  { field: "ports", label: "Ports", icon: NetworkIcon, hint: "One stable port per name, exported under that name." },
  {
    field: "artifacts",
    label: "Artifacts",
    icon: PackageIcon,
    hint: "Output a worktree can regenerate. Telar never runs the command.",
    info: `One per line: a path, optionally followed by ${ARTIFACT_SEPARATOR} and the command that rebuilds it. * matches within one path segment.`,
  },
];

const SUGGESTED_ARTIFACT = "node_modules";

const REPO_FILE = "the repo's .telar/workspace.json";

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function BlurText({
  value,
  onCommit,
  multiline,
  className,
  ...rest
}: {
  value: string;
  onCommit: (next: string) => void;
  multiline?: boolean;
  placeholder?: string;
  "aria-label": string;
  className?: string;
  inputMode?: "numeric";
}) {
  const [draft, setDraft] = useState(value);
  const escape = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key !== "Escape") return;
    setDraft(value);
    event.currentTarget.blur();
  };
  const onBlur = () => {
    if (draft !== value) onCommit(draft);
  };
  return multiline ? (
    <Textarea
      {...rest}
      value={draft}
      className={cn("min-h-16 font-mono text-xs md:text-xs", className)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={onBlur}
      onKeyDown={escape}
    />
  ) : (
    <Input
      {...rest}
      value={draft}
      className={cn("h-8 font-mono text-xs md:text-xs", className)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={onBlur}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        escape(event);
      }}
    />
  );
}

type Commit<T> = { commit: (next: T | undefined) => void; reject: (message: string) => void };

function SetupEditor({ value, required, commit, reject }: { value: WorkspaceSetup | undefined; required: boolean } & Commit<WorkspaceSetup>) {
  const seconds = value?.timeoutMs ? String(value.timeoutMs / 1000) : "";
  return (
    <div className="mt-2 flex flex-col gap-2">
      <BlurText
        key={value?.command ?? ""}
        value={value?.command ?? ""}
        placeholder="install command"
        aria-label="Setup command"
        onCommit={(next) => {
          const command = next.trim();
          if (command) return commit({ ...value, command });
          if (required) return reject("Setup needs a command.");
          commit(undefined);
        }}
      />
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Switch
          size="sm"
          checked={value?.blocking === true}
          disabled={!value}
          aria-label="Hold the first turn until it finishes"
          onCheckedChange={(next) => {
            if (!value) return;
            const rest = { ...value };
            delete rest.blocking;
            commit(next ? { ...rest, blocking: true } : rest);
          }}
        />
        Hold the first turn until it finishes
      </label>
      <div className={cn("flex items-center gap-2 text-xs text-muted-foreground", !value && "pointer-events-none opacity-50")}>
        Timeout
        <BlurText
          key={seconds}
          value={seconds}
          inputMode="numeric"
          placeholder="none"
          aria-label="Setup timeout in seconds"
          className="w-20"
          onCommit={(next) => {
            if (!value) return;
            const rest = { ...value };
            delete rest.timeoutMs;
            const trimmed = next.trim();
            if (!trimmed) return commit(rest);
            const count = Number(trimmed);
            if (!Number.isInteger(count) || count <= 0 || count > 86_400) return reject("Timeout is whole seconds, up to a day.");
            commit({ ...rest, timeoutMs: count * 1000 });
          }}
        />
        seconds
      </div>
    </div>
  );
}

function TextEditor<F extends TextField>({
  field,
  label,
  value,
  required,
  commit,
  reject,
}: { field: F; label: string; value: Values[F] | undefined; required: boolean } & Commit<Values[F]>) {
  const spec = TEXT[field] as TextSpec<F>;
  const text = spec.format(value);
  return (
    <div className="mt-2 flex flex-col items-start gap-1.5">
      <BlurText
        key={text}
        value={text}
        multiline={spec.multiline}
        placeholder={spec.placeholder}
        aria-label={label}
        className="w-full"
        onCommit={(draft) => {
          const parsed = spec.parse(draft, value);
          if (!parsed.ok) return reject(parsed.message);
          if (parsed.value !== undefined || !required) return commit(parsed.value);
          if (spec.empty !== undefined) return commit(spec.empty);
          reject(spec.required ?? "This needs an entry.");
        }}
      />
      {field === "artifacts" && !text && (
        <Button size="xs" variant="outline" onClick={() => commit([{ path: SUGGESTED_ARTIFACT }] as Values[F])}>
          Add {SUGGESTED_ARTIFACT}
        </Button>
      )}
    </div>
  );
}

function FieldEditor({
  field,
  label,
  value,
  required,
  commit,
  reject,
}: { field: ModeField; label: string; value: unknown; required: boolean } & Commit<unknown>) {
  if (field === "setup") {
    return <SetupEditor value={value as WorkspaceSetup | undefined} required={required} commit={commit} reject={reject} />;
  }
  return <TextEditor field={field} label={label} value={value as never} required={required} commit={commit} reject={reject} />;
}

function formatAny(field: ModeField, value: unknown): string {
  return field === "setup" ? formatSetup(value as WorkspaceSetup | undefined) : TEXT[field].format(value as never);
}

export type WorkspaceWriter = {
  save: (field: WorkspaceRowField, next: unknown) => void;
  reject: (field: WorkspaceRowField, message: string) => void;
  busy?: WorkspaceRowField;
  error?: { field: WorkspaceRowField; message: string };
};

function rowState(writer: WorkspaceWriter | undefined, field: WorkspaceRowField) {
  return {
    ...(writer?.busy === field ? { status: <Badge variant="outline">Saving</Badge> } : {}),
    ...(writer?.error?.field === field ? { error: writer.error.message } : {}),
  };
}

function useLayerWriter<L>(put: (layer: L) => Promise<L>, apply: (layer: L) => void) {
  const [busy, setBusy] = useState<WorkspaceRowField>();
  const [error, setError] = useState<{ field: WorkspaceRowField; message: string }>();
  const latest = useRef<L | undefined>(undefined);
  const queue = useRef<Promise<void>>(Promise.resolve());

  const answered = (layer: L) => {
    latest.current = layer;
    apply(layer);
  };

  const writer = (build: (base: L, field: WorkspaceRowField, next: unknown) => L): WorkspaceWriter => ({
    ...(busy ? { busy } : {}),
    ...(error ? { error } : {}),
    reject: (field, reason) => setError({ field, message: reason }),
    save: (field, next) => {
      queue.current = queue.current.then(async () => {
        const base = latest.current;
        if (base === undefined) return;
        setBusy(field);
        setError(undefined);
        try {
          answered(await put(build(base, field, next)));
        } catch (cause) {
          setError({ field, message: message(cause) });
        } finally {
          setBusy(undefined);
        }
      });
    },
  });

  return { answered, writer };
}

type Mode = "inherit" | "off" | "custom";

const DEPENDENCY_LABELS: Record<WorkspaceDependencies, string> = { install: "Install", share: "Share", none: "None" };

function DependenciesRow({ view, writer }: { view: ProjectWorkspaceView; writer: WorkspaceWriter | undefined }) {
  const inherited = resolveWorkspace(view.machine, view.proposal.config, { ...view.overrides, dependencies: undefined }).effective.dependencies;
  return (
    <Row
      label="Dependencies"
      icon={BoxesIcon}
      hint="How a new worktree gets node_modules and .venv: install them with the setup command, share the checkout's, or neither."
      info="Share skips the setup command and uses no extra disk, but a package installed or removed in the worktree changes the checkout's too, and a branch that changes the lockfile needs Install."
      {...rowState(writer, "dependencies")}
      control={
        <Dropdown<WorkspaceDependencies | "inherit">
          value={view.overrides.dependencies ?? "inherit"}
          label="Dependencies"
          className="w-28"
          onChange={(next) => writer?.save("dependencies", next === "inherit" ? undefined : next)}
          options={[
            { value: "inherit", label: `Inherit (${DEPENDENCY_LABELS[inherited ?? "install"]})` },
            ...(["install", "share", "none"] as const).map((value) => ({ value, label: DEPENDENCY_LABELS[value] })),
          ]}
        />
      }
    />
  );
}

function inheritedFrom(view: ProjectWorkspaceView, field: WorkspaceRowField, source: WorkspaceSource | undefined): string {
  if (field === "env") {
    const mac = Object.keys(view.machine.env ?? {}).length > 0;
    const repo = Object.keys(view.proposal.config?.env ?? {}).length > 0;
    if (mac && repo) return `From this Mac and ${REPO_FILE}`;
  }
  return source === "proposed" ? `From ${REPO_FILE}` : "From this Mac's defaults";
}

function Inherited({ caption, text }: { caption: string; text: string }) {
  return (
    <div className="mt-2">
      <p className="text-2xs text-muted-foreground">{text ? caption : "Nothing to inherit."}</p>
      {text && <pre className="mt-1 whitespace-pre-wrap break-all rounded-md bg-muted px-2 py-1.5 font-mono text-2xs">{text}</pre>}
    </div>
  );
}

export function ProjectWorkspaceRows({ view, writer }: { view: ProjectWorkspaceView; writer?: WorkspaceWriter }) {
  const [drafting, setDrafting] = useState<ModeField[]>([]);

  const modeOf = (field: ModeField): Mode => {
    const own = view.overrides[field];
    if (own === null) return "off";
    if (own !== undefined || drafting.includes(field)) return "custom";
    return "inherit";
  };

  const choose = (field: ModeField, mode: Mode, inherited: unknown) => {
    setDrafting((current) => current.filter((entry) => entry !== field));
    if (mode === "inherit") return writer?.save(field, undefined);
    if (mode === "off") return writer?.save(field, null);
    const seed = field === "env" ? {} : (inherited ?? (field === "setup" ? undefined : TEXT[field].empty));
    if (seed === undefined) setDrafting((current) => [...current, field]);
    else writer?.save(field, seed);
  };

  return (
    <SettingsGroup title="New worktrees">
      {view.proposal.error && (
        <Row
          label="Repo file"
          icon={FileWarningIcon}
          hint={`Could not read .telar/workspace.json, so nothing is inherited from it: ${view.proposal.error}`}
        />
      )}
      {ROWS.map(({ field, label, icon, hint, info }) => {
        const mode = modeOf(field);
        const { effective, sources } = resolveWorkspace(view.machine, view.proposal.config, { ...view.overrides, [field]: undefined });
        const inherited = effective[field];
        return (
          <Row
            key={field}
            label={label}
            icon={icon}
            hint={hint}
            {...(info ? { info } : {})}
            {...rowState(writer, field)}
            control={
              <Dropdown<Mode>
                value={mode}
                label={label}
                className="w-28"
                onChange={(next) => choose(field, next, inherited)}
                options={[
                  { value: "inherit", label: "Inherit" },
                  { value: "off", label: "Off" },
                  { value: "custom", label: "Custom" },
                ]}
              />
            }
          >
            {mode === "inherit" && <Inherited caption={inheritedFrom(view, field, sources[field])} text={formatAny(field, inherited)} />}
            {mode === "custom" && (
              <FieldEditor
                field={field}
                label={label}
                value={view.overrides[field] ?? undefined}
                required
                commit={(next) => writer?.save(field, next)}
                reject={(reason) => writer?.reject(field, reason)}
              />
            )}
          </Row>
        );
      })}
      <DependenciesRow view={view} writer={writer} />
    </SettingsGroup>
  );
}

export function ProjectWorkspaceSection({ projectId }: { projectId: string }) {
  const [view, setView] = useState<ProjectWorkspaceView>();
  const [failed, setFailed] = useState<string>();
  const { answered, writer } = useLayerWriter<ProjectWorkspaceView>(
    async (next) => (await api.setProjectWorkspace(projectId, next.overrides)).workspace,
    setView,
  );

  useEffect(() => {
    const task = window.setTimeout(() => {
      api
        .projectWorkspace(projectId)
        .then((answer) => answered(answer.workspace))
        .catch((cause) => setFailed(message(cause)));
    }, 0);
    return () => window.clearTimeout(task);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  if (failed) {
    return (
      <SettingsGroup title="New worktrees">
        <Row label="Worktree preparation" icon={FileWarningIcon} error={failed} />
      </SettingsGroup>
    );
  }
  if (!view) return null;
  return (
    <ProjectWorkspaceRows
      view={view}
      writer={writer((base, field, next) => {
        const overrides: Record<string, unknown> = { ...base.overrides };
        if (next === undefined) delete overrides[field];
        else overrides[field] = next;
        return { ...base, overrides: overrides as ProjectWorkspaceOverrides };
      })}
    />
  );
}
