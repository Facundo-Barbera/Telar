"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BlocksIcon,
  CircleAlertIcon,
  FolderGitIcon,
  FolderKanbanIcon,
  GaugeIcon,
  ImageIcon,
  MonitorIcon,
  SparklesIcon,
} from "lucide-react";
import type { EnvMode, PluginStatus, Project, ProjectPlugins, ProviderDriverKind, ProviderInstance, ProviderModel } from "@telar/engine-client";
import { defaultInstanceIdForDriver, machineAllows, pluginEnabled, readProjectPlugins } from "@telar/engine-client";
import type { PublicHost } from "@telar/engine-client";
import { choiceNamesAnything, choiceOf, sessionModelSelection, type ModelChoice, useModelCatalogue } from "@/features/providers";
import { createEngineApi } from "@/platform/engine/index";
import { hostFetcher } from "@/lib/hosts/client";
import { LOCAL_HOST_ID } from "@telar/engine-client";
import { enablePatch, projectPluginSections, projectPaneFor, machineOffReason, PluginSettings } from "@/features/plugins";
import { useSessionDefaults } from "@/features/sessions";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { AgentControl, modelOptionsOf, ReasoningControl } from "@/features/composer/index";
import { ProjectIconPicker } from "./project-icon-picker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { McpSection } from "@/features/agent-tools";
import { RemoveProjectSection } from "./remove-project-section";
import { Dropdown, Row, Segmented, SettingsGroup, ToggleRow } from "@/features/settings";
import { ProjectWorkspaceSection } from "./workspace-config-section";

const api = createEngineApi();

type ProjectWriter = {
  save: (field: string, patch: ProjectPatch) => void;
  busy?: string;
  error?: { field: string; message: string };
};

type ProjectPatch = Parameters<typeof api.updateProject>[1];

function blockedReason(project: ScopedProject | undefined, what: string): string | undefined {
  if (!project) return `Select a project to ${what}.`;
  if (project.hostId) return `Registered on ${project.hostName ?? "another Mac"}. Change it in that Mac's own settings.`;
  return undefined;
}

const FOLLOW_APP = "__follow-app";

function BlurInput({
  value,
  onCommit,
  ...rest
}: { value: string; onCommit: (next: string) => void } & Omit<React.ComponentProps<"input">, "value" | "onChange" | "onBlur">) {
  const [draft, setDraft] = useState(value);
  return (
    <Input
      {...rest}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

const ALL_PROJECTS = "__all-projects";

export type ScopedProject = Project & { hostId?: string; hostName?: string };

export function ProjectIdentityRows({ project, writer }: { project?: ScopedProject; writer?: ProjectWriter }) {
  const errorFor = (field: string) => (writer?.error?.field === field ? writer.error.message : undefined);
  const savingFor = (field: string) => (writer?.busy === field ? <Badge variant="outline">Saving</Badge> : undefined);
  const picked = Boolean(project?.iconName ?? project?.iconEmoji);

  return (
    <SettingsGroup title="Identity">
      <Row
        label="Name"
        icon={FolderKanbanIcon}
        hint="Shown in the rail, the pickers and session headers. The folder on disk is not renamed."
        {...(savingFor("name") ? { status: savingFor("name") } : {})}
        {...(errorFor("name") ? { error: errorFor("name") } : {})}
        control={
          <BlurInput
            key={project?.name ?? ""}
            className="h-8 w-56 text-xs"
            aria-label="Project name"
            value={project?.name ?? ""}
            onCommit={(next) => writer?.save("name", { name: next })}
          />
        }
        {...(blockedReason(project, "rename it") ? { unavailable: { reason: blockedReason(project, "rename it")! } } : {})}
      />
      <Row
        label="Icon"
        icon={ImageIcon}
        hint={
          picked
            ? "Your pick, which beats whatever icon the checkout carries. Auto-detect goes back to the file."
            : "Auto-detect: a favicon, an app icon or .telar/icon.* from the checkout, else the project's initial."
        }
        {...(savingFor("iconName") ? { status: savingFor("iconName") } : {})}
        {...(errorFor("iconName") ? { error: errorFor("iconName") } : {})}
        {...(picked ? { onRevert: () => writer?.save("iconName", { iconName: null, iconEmoji: null }) } : {})}
        control={
          <ProjectIconPicker
            {...(project?.name ? { name: project.name } : {})}
            {...(project?.id ? { projectId: project.id } : {})}
            {...(project?.icon ? { icon: project.icon } : {})}
            {...(project?.iconName ? { iconName: project.iconName } : {})}
            {...(project?.iconEmoji ? { iconEmoji: project.iconEmoji } : {})}
            onPick={(next) => writer?.save("iconName", next === null ? { iconName: null, iconEmoji: null } : { iconName: next })}
          />
        }
        {...(blockedReason(project, "mark it") ? { unavailable: { reason: blockedReason(project, "mark it")! } } : {})}
      />
      {project && (
        <Row
          label="Checkout"
          icon={FolderGitIcon}
          hint="Sessions run here, or in a worktree cut from it."
          control={<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-2xs">{project.root}</code>}
        />
      )}
    </SettingsGroup>
  );
}

export function ProjectModelOptionsRow({
  driver,
  choice,
  instanceId,
  models,
  onChange,
  status,
  error,
  unavailable,
}: {
  driver: ProviderDriverKind;
  choice: ModelChoice;
  instanceId?: string;
  models?: readonly ProviderModel[];
  onChange: (next: ModelChoice) => void;
  status?: React.ReactNode;
  error?: string;
  unavailable?: string;
}) {
  const offered = modelOptionsOf(models ?? [], choice, driver);
  if (offered.efforts.length === 0 && !offered.fastMode && offered.serviceTiers.length === 0) return null;
  const { model, ...options } = choiceOf(choice);
  const set = Object.keys(options).length > 0;
  return (
    <Row
      label="Model options"
      icon={GaugeIcon}
      hint="New conversations in this project start with this model and these options."
      info="Only the options the chosen model offers are shown. Picking a model that lacks one drops it, and the composer still overrides them for the conversation in front of you."
      {...(status ? { status } : {})}
      {...(error ? { error } : {})}
      {...(set ? { onRevert: () => onChange(model ? { model } : {}) } : {})}
      control={<ReasoningControl driver={driver} choice={choice} {...(instanceId ? { instanceId } : {})} onChange={onChange} />}
      {...(unavailable ? { unavailable: { reason: unavailable } } : {})}
    />
  );
}

export function ProjectConversationRows({
  project,
  envMode,
  instances,
  writer,
}: {
  project?: ScopedProject;
  envMode: EnvMode;
  instances?: ProviderInstance[];
  writer?: ProjectWriter;
}) {
  const stored = project?.defaultModel;
  const storedDriver = instances?.find((instance) => instance.id === stored?.instanceId)?.driver;
  const [picked, setPicked] = useState<ProviderDriverKind>();
  const driver = picked ?? storedDriver ?? "claude";
  const choice = choiceOf(stored);

  const commitModel = (next: ModelChoice, field = "defaultModel") => {
    if (!choiceNamesAnything(next)) return writer?.save(field, { defaultModel: null });
    const instanceId = storedDriver === driver && stored ? stored.instanceId : defaultInstanceIdForDriver(driver);
    writer?.save(field, { defaultModel: sessionModelSelection(instanceId, next)! });
  };

  const errorFor = (field: string) => (writer?.error?.field === field ? writer.error.message : undefined);
  const savingFor = (field: string) => (writer?.busy === field ? <Badge variant="outline">Saving</Badge> : undefined);
  const instanceId = stored?.instanceId && storedDriver === driver ? stored.instanceId : undefined;
  const models = useModelCatalogue(driver, instanceId)?.models;

  return (
    <SettingsGroup title="New conversations">
      <Row
        label="Default model"
        icon={SparklesIcon}
        hint={
          stored
            ? "Conversations in this project open on this. The composer still overrides it for the one in front of you."
            : "Nothing stored, so a conversation opens on the provider's own default. Pick one to make this project differ."
        }
        {...(savingFor("defaultModel") ? { status: savingFor("defaultModel") } : {})}
        {...(errorFor("defaultModel") ? { error: errorFor("defaultModel") } : {})}
        {...(stored ? { onRevert: () => writer?.save("defaultModel", { defaultModel: null }) } : {})}
        control={
          <AgentControl
            driver={driver}
            choice={choice}
            {...(instanceId ? { instanceId } : {})}
            onChange={(next) => commitModel(next)}
            onDriverChange={setPicked}
          />
        }
        {...(blockedReason(project, "set the model its conversations open on") ? { unavailable: { reason: blockedReason(project, "set the model its conversations open on")! } } : {})}
      />
      <ProjectModelOptionsRow
        driver={driver}
        choice={choice}
        {...(instanceId ? { instanceId } : {})}
        {...(models ? { models } : {})}
        onChange={(next) => commitModel(next, "modelOptions")}
        {...(savingFor("modelOptions") ? { status: savingFor("modelOptions") } : {})}
        {...(errorFor("modelOptions") ? { error: errorFor("modelOptions") } : {})}
        {...(blockedReason(project, "set the options its conversations open with")
          ? { unavailable: blockedReason(project, "set the options its conversations open with")! }
          : {})}
      />
      <Row
        label="Where new conversations start"
        icon={FolderGitIcon}
        hint={
          project?.envMode === undefined
            ? `Following the app default, which says ${envMode === "worktree" ? "each session gets its own checkout" : "sessions share the project's checkout"}. Change that on General ▸ Workspace, or pin an answer here.`
            : project.envMode === "worktree"
              ? "Each session here gets its own checkout and branch, whatever the app default says. A project without git falls back to the checkout."
              : "Sessions here share the project's checkout, whatever the app default says. Two at once will collide."
        }
        {...(savingFor("envMode") ? { status: savingFor("envMode") } : {})}
        {...(errorFor("envMode") ? { error: errorFor("envMode") } : {})}
        control={
          <Dropdown<string>
            value={project?.envMode ?? FOLLOW_APP}
            label="Where new conversations start"
            onChange={(next) => writer?.save("envMode", { envMode: next === FOLLOW_APP ? null : (next as EnvMode) })}
            options={[
              { value: FOLLOW_APP, label: `Inherit (${envMode === "worktree" ? "Own worktree" : "Project checkout"})` },
              { value: "local", label: "Project checkout" },
              { value: "worktree", label: "Own worktree" },
            ]}
          />
        }
        {...(blockedReason(project, "say where its conversations start") ? { unavailable: { reason: blockedReason(project, "say where its conversations start")! } } : {})}
      />
    </SettingsGroup>
  );
}

export function ProjectPluginRows({
  project,
  plugins,
  machine,
  onChange,
}: {
  project?: ScopedProject;
  plugins?: PluginStatus[];
  machine?: ProjectPlugins;
  onChange?: (project: Project) => void;
}) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const entries = useMemo(() => projectPluginSections(plugins), [plugins]);
  const remote = Boolean(project?.hostId);

  const toggle = async (pluginId: string, next: boolean) => {
    if (!project) return;
    setBusy(pluginId);
    setError(undefined);
    try {
      const answer = await api.updateProject(project.id, enablePatch(pluginId, next));
      onChange?.(answer.project);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const shown = entries.length > 0 ? entries : undefined;

  return (
    <SettingsGroup title="Plugins" description="Which of this Mac's plugins this project has opted into.">
      {!shown && <Row icon={BlocksIcon} label="No plugins registered" control={<Badge variant="outline">None</Badge>} />}
      {shown?.map((entry) => {
        const failed = entry.state === "failed";
        const reason = !project
          ? `Select a project to turn ${entry.label} on for it.`
          : remote
            ? `Registered on ${project?.hostName ?? "another Mac"}. Change it in that Mac's own settings.`
            : failed
              ? (entry.error ?? "This plugin did not start, so turning it on would do nothing.")
              : !machineAllows(machine, entry.pluginId)
                ? machineOffReason(entry.label)
                : undefined;
        return (
          <ToggleRow
            key={entry.key}
            label={entry.label}
            icon={BlocksIcon}
            hint={entry.blurb ?? "Sessions in this project get its tools; turning it off lets running work finish."}
            checked={project ? pluginEnabled(readProjectPlugins(project).plugins, entry.pluginId) : false}
            onCheckedChange={(next) => void toggle(entry.pluginId, next)}
            {...(busy === entry.pluginId ? { status: <Badge variant="outline">Saving</Badge> } : {})}
            {...(reason ? { unavailable: { reason } } : {})}
          />
        );
      })}
      {error && <Row icon={CircleAlertIcon} label="Could not save" hint={error} control={<Badge variant="outline">Error</Badge>} />}
    </SettingsGroup>
  );
}

export function ProjectPluginPanes({
  project,
  plugins,
  machine,
  onChange,
}: {
  project: Project;
  plugins?: PluginStatus[];
  machine?: ProjectPlugins;
  onChange: (project: Project) => void;
}) {
  const entries = useMemo(() => projectPluginSections(plugins), [plugins]);
  const enabled = readProjectPlugins(project).plugins;

  return (
    <>
      {entries.map((entry) => {
        if (!machineAllows(machine, entry.pluginId)) {
          return <PluginSettings key={entry.key} entry={entry} project={project} onChange={onChange} machineOff />;
        }
        const Pane = pluginEnabled(enabled, entry.pluginId) ? projectPaneFor(entry.pluginId) : undefined;
        const machineSettings = machine?.entries[entry.pluginId]?.settings;
        return Pane ? (
          <Pane key={entry.key} project={project} onChange={onChange} />
        ) : (
          <PluginSettings
            key={entry.key}
            entry={entry}
            project={project}
            onChange={onChange}
            {...(machineSettings ? { machineSettings } : {})}
          />
        );
      })}
    </>
  );
}

export function ProjectsPage() {
  const [hosts, setHosts] = useState<PublicHost[]>([]);
  const [hostId, setHostId] = useState<string>(LOCAL_HOST_ID);
  const [byHost, setByHost] = useState<Record<string, ScopedProject[]>>({});
  const [selected, setSelected] = useState<string>(ALL_PROJECTS);
  const [plugins, setPlugins] = useState<PluginStatus[]>();
  const [machine, setMachine] = useState<ProjectPlugins>();
  const [instances, setInstances] = useState<ProviderInstance[]>();
  const [unreachable, setUnreachable] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<{ field: string; message: string }>();
  const { defaults } = useSessionDefaults();

  const projects = byHost[hostId] ?? [];
  const project = projects.find((entry) => entry.id === selected);

  const answered = byHost[hostId];
  const [lastAnswered, setLastAnswered] = useState(answered);
  if (lastAnswered !== answered) {
    setLastAnswered(answered);
    if (answered?.length === 1 && selected === ALL_PROJECTS) setSelected(answered[0]!.id);
  }

  const loadHost = useCallback(async (id: string) => {
    const hostApi = createEngineApi(hostFetcher(id));
    const answer = await hostApi.projects();
    return answer.projects;
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => {
      void (async () => {
        const book = await api
          .hosts()
          .then((answer) => answer.hosts)
          .catch(() => [] as PublicHost[]);
        setHosts(book);
        try {
          setByHost({ [LOCAL_HOST_ID]: await loadHost(LOCAL_HOST_ID) });
          setUnreachable(false);
        } catch {
          setUnreachable(true);
        }
        setPlugins(await api.health().then((health) => health.plugins ?? []).catch(() => []));
        setMachine(await api.machinePlugins().then((answer) => answer.machine).catch(() => undefined));
        setInstances(await api.providerInstances().then((answer) => answer.providerInstances).catch(() => []));
      })();
    }, 0);
    return () => window.clearTimeout(task);
  }, [loadHost]);

  useEffect(() => {
    if (hostId === LOCAL_HOST_ID || byHost[hostId]) return;
    const task = window.setTimeout(() => {
      void loadHost(hostId)
        .then((found) => {
          const host = hosts.find((entry) => entry.id === hostId);
          setByHost((current) => ({
            ...current,
            [hostId]: found.map((entry) => ({ ...entry, hostId, ...(host ? { hostName: host.name } : {}) })),
          }));
        })
        .catch(() => setByHost((current) => ({ ...current, [hostId]: [] })));
    }, 0);
    return () => window.clearTimeout(task);
  }, [hostId, byHost, hosts, loadHost]);

  useEffect(() => {
    const task = window.setTimeout(() => {
      const named = new URLSearchParams(window.location.search).get("project");
      if (named) setSelected(named);
    }, 0);
    return () => window.clearTimeout(task);
  }, []);

  const replaceProject = (next: Project) => {
    setByHost((current) => ({
      ...current,
      [hostId]: (current[hostId] ?? []).map((entry) => (entry.id === next.id ? { ...entry, ...next } : entry)),
    }));
  };

  const writer: ProjectWriter = {
    ...(busy ? { busy } : {}),
    ...(error ? { error } : {}),
    save: (field, patch) => {
      if (!project || project.hostId) return;
      setBusy(field);
      setError(undefined);
      void api
        .updateProject(project.id, patch)
        .then((answer) => replaceProject(answer.project))
        .catch((cause) => setError({ field, message: cause instanceof Error ? cause.message : String(cause) }))
        .finally(() => setBusy(undefined));
    },
  };

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        {hosts.length > 0 && (
          <Segmented<string>
            value={hostId}
            onChange={(next) => {
              setHostId(next);
              setSelected(ALL_PROJECTS);
            }}
            options={[
              { value: LOCAL_HOST_ID, label: "This Mac" },
              ...hosts.map((host) => ({
                value: host.id,
                label: (
                  <>
                    <MonitorIcon className="size-3" />
                    {host.name}
                  </>
                ),
              })),
            ]}
          />
        )}
        <Select value={selected} onValueChange={(next) => typeof next === "string" && setSelected(next)}>
          <SelectTrigger size="sm" className="ml-auto w-56" aria-label="Project these settings are about">
            <FolderKanbanIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <SelectValue>
              {selected === ALL_PROJECTS ? "All projects" : (project?.name ?? "Select a project")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {projects.length !== 1 && <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>}
            {projects.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {unreachable && (
        <p className="-mt-4 mb-6 text-xs text-muted-foreground">The engine is not answering, so there is nothing to choose from.</p>
      )}

      <ProjectIdentityRows {...(project ? { project } : {})} writer={writer} />
      <ProjectConversationRows
        {...(project ? { project } : {})}
        envMode={defaults.envMode}
        {...(instances ? { instances } : {})}
        writer={writer}
      />
      {(!project || project.hostId) && (
        <ProjectPluginRows
          {...(project ? { project } : {})}
          {...(plugins ? { plugins } : {})}
          {...(machine ? { machine } : {})}
          onChange={replaceProject}
        />
      )}

      {project && !project.hostId && (
        <>
          <McpSection scope={{ projectId: project.id, projectName: project.name }} />
          <ProjectWorkspaceSection key={project.id} projectId={project.id} />
          <ProjectPluginPanes
            project={project}
            {...(plugins ? { plugins } : {})}
            {...(machine ? { machine } : {})}
            onChange={replaceProject}
          />
        </>
      )}

      {project && !project.hostId && <RemoveProjectSection key={project.id} project={project} onChange={replaceProject} />}
    </>
  );
}
